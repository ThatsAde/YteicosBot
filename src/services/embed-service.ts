import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  type APIEmbedField,
  type BaseMessageOptions,
  type InteractionReplyOptions,
} from "discord.js";
import {
  CustomIdTooLongError,
  EmbedTooLargeError,
  EmptyModalError,
  InvalidButtonConfigError,
  InvalidSelectConfigError,
  TooManyButtonsError,
  TooManyComponentRowsError,
  TooManyFieldsError,
} from "../domain/errors.js";

/**
 * Embed service — costruzione di embed/componenti con uno stile coerente col
 * brand Yteicos (dark glaciale + accento ambra). Nessuno stato condiviso fra
 * istanze: ogni builder e' usa-e-getta, ottenuto da EmbedService.
 *
 * Il servizio e' anche l'unico punto in cui i limiti dell'API Discord vengono
 * fatti rispettare. La regola e' asimmetrica ed e' voluta:
 * - il TESTO viene troncato (meglio un'etichetta accorciata che un messaggio
 *   rifiutato in blocco: Discord scarta l'intero payload, non il campo lungo);
 * - i DATI DI ROUTING (customId, valori delle opzioni) e gli sforamenti
 *   strutturali (righe, bottoni, campi) lanciano: troncarli produrrebbe un
 *   pannello che sembra a posto ma i cui bottoni non arrivano piu' a nessun
 *   handler.
 */

export const BRAND_NAME = "Yteicos";

export const Colors = {
  GlacialDark: 0x0b1420,
  GlacialAccent: 0x1c2b3a,
  Amber: 0xffb648,
  Success: 0x4ade80,
  Error: 0xef4444,
  Warning: 0xfbbf24,
  Info: 0x60a5fa,
  Pending: 0x94a3b8,
} as const;

/** Limiti dell'API Discord (https://discord.com/developers/docs/resources/message). */
export const Limits = {
  Title: 256,
  Description: 4096,
  FieldName: 256,
  FieldValue: 1024,
  FieldCount: 25,
  Footer: 2048,
  AuthorName: 256,
  /** Somma di title + description + footer + author + tutti i campi. */
  EmbedTotal: 6000,
  Content: 2000,
  ModalTitle: 45,
  /** 45, non 80 come i bottoni: e' il limite che faceva fallire la modal di verifica. */
  InputLabel: 45,
  InputPlaceholder: 100,
  InputValue: 4000,
  ModalRows: 5,
  ButtonLabel: 80,
  CustomId: 100,
  SelectPlaceholder: 150,
  SelectOptionLabel: 100,
  SelectOptionValue: 100,
  SelectOptionDescription: 100,
  SelectOptions: 25,
} as const;

const MAX_BUTTONS_PER_ROW = 5;
const MAX_ACTION_ROWS = 5;
const MAX_BUTTONS_TOTAL = MAX_BUTTONS_PER_ROW * MAX_ACTION_ROWS;

/** Taglia a `max` caratteri ellissi inclusa, cosi' il risultato non sfora mai. */
export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function assertCustomId(customId: string): string {
  if (customId.length > Limits.CustomId) throw new CustomIdTooLongError(customId, Limits.CustomId);
  return customId;
}

// Non esportata come classe (solo il tipo, tramite `export type` in fondo al
// file): i consumer devono passare da EmbedService.basic()/buttons(), mai da
// `new`, cosi' lo stile resta centralizzato in un solo punto.
class BasicEmbedBuilder {
  protected readonly embed = new EmbedBuilder();
  protected messageContent?: string;
  private fieldCount = 0;

  /** Stile di default: chi non dice nulla ottiene comunque un embed brandizzato. */
  constructor() {
    this.embed.setColor(Colors.GlacialAccent).setFooter({ text: BRAND_NAME });
  }

  title(title: string): this {
    this.embed.setTitle(truncate(title, Limits.Title));
    return this;
  }

  description(description: string): this {
    this.embed.setDescription(truncate(description, Limits.Description));
    return this;
  }

  /**
   * Descrizione costruita da una lista di righe di lunghezza imprevedibile
   * (elenchi di ticket, di utenti, ...): tiene solo le righe che entrano nel
   * limite e chiude con una nota su quante ne restano fuori. Senza questo ogni
   * chiamante finisce per reinventare la stessa somma a mano.
   */
  descriptionLines(
    lines: readonly string[],
    overflowNote: (hidden: number) => string = (hidden) => `_…and ${hidden} more rows._`,
  ): this {
    const kept: string[] = [];
    let length = 0;

    for (const [index, line] of lines.entries()) {
      const note = overflowNote(lines.length - index);
      const cost = kept.length === 0 ? line.length : line.length + 1;

      // Si riserva spazio per la nota di troncamento PRIMA di accettare la
      // riga: aggiungerla dopo potrebbe far sforare il limite.
      if (length + cost + 1 + note.length > Limits.Description) {
        kept.push(note);
        break;
      }

      length += cost;
      kept.push(line);
    }

    return this.description(kept.join("\n"));
  }

  footer(text: string, iconUrl?: string): this {
    this.embed.setFooter({ text: truncate(text, Limits.Footer), iconURL: iconUrl });
    return this;
  }

  /** setTimestamp() vuole una Date o un epoch millis, non uno stile di formattazione inline. */
  timestamp(value: Date | number = Date.now()): this {
    this.embed.setTimestamp(value);
    return this;
  }

  color(color: number): this {
    this.embed.setColor(color);
    return this;
  }

  field(name: string, value: string, inline = false): this {
    if (this.fieldCount >= Limits.FieldCount) throw new TooManyFieldsError(Limits.FieldCount);
    this.embed.addFields({
      name: truncate(name, Limits.FieldName),
      value: truncate(value, Limits.FieldValue),
      inline,
    });
    this.fieldCount++;
    return this;
  }

  fields(fields: readonly APIEmbedField[]): this {
    for (const entry of fields) this.field(entry.name, entry.value, entry.inline);
    return this;
  }

  author(name: string, iconUrl?: string, url?: string): this {
    this.embed.setAuthor({ name: truncate(name, Limits.AuthorName), iconURL: iconUrl, url });
    return this;
  }

  thumbnail(url: string): this {
    this.embed.setThumbnail(url);
    return this;
  }

  image(url: string): this {
    this.embed.setImage(url);
    return this;
  }

  /**
   * Testo fuori dall'embed. Serve quando il messaggio deve notificare davvero
   * qualcuno: le menzioni dentro un embed non generano ping.
   */
  content(text: string): this {
    this.messageContent = truncate(text, Limits.Content);
    return this;
  }

  /**
   * I limiti per campo non bastano: Discord rifiuta l'embed anche quando la
   * somma supera 6000 caratteri, e a quel punto nessun singolo troncamento
   * sarebbe quello "giusto" da fare in automatico.
   */
  protected assertWithinTotalBudget(): void {
    const data = this.embed.data;
    const total =
      (data.title?.length ?? 0) +
      (data.description?.length ?? 0) +
      (data.footer?.text.length ?? 0) +
      (data.author?.name.length ?? 0) +
      (data.fields?.reduce((sum, entry) => sum + entry.name.length + entry.value.length, 0) ?? 0);

    if (total > Limits.EmbedTotal) throw new EmbedTooLargeError(total, Limits.EmbedTotal);
  }

  protected baseOptions(): BaseMessageOptions {
    this.assertWithinTotalBudget();
    return { embeds: [this.embed], ...(this.messageContent ? { content: this.messageContent } : {}) };
  }
}

class StandardEmbedBuilder extends BasicEmbedBuilder {
  build(): BaseMessageOptions {
    return this.baseOptions();
  }

  /** Risposta visibile solo a chi ha interagito: la forma piu' usata nei pannelli. */
  buildEphemeral(): InteractionReplyOptions {
    return { ...this.build(), flags: MessageFlags.Ephemeral };
  }
}

interface ButtonOptions {
  label: string;
  emoji?: string;
  disabled?: boolean;
  /** Bottone d'azione: richiede customId. Mutuamente esclusivo con url. */
  customId?: string;
  /** Bottone link: richiede url (stile sempre Link). Mutuamente esclusivo con customId. */
  url?: string;
  /** Ignorato per i bottoni link, che sono sempre ButtonStyle.Link. */
  style?: Exclude<ButtonStyle, ButtonStyle.Link>;
}

interface SelectOption {
  label: string;
  value: string;
  description?: string;
  emoji?: string;
  default?: boolean;
}

interface SelectOptions {
  customId: string;
  placeholder?: string;
  minValues?: number;
  maxValues?: number;
  disabled?: boolean;
  options: readonly SelectOption[];
}

interface UserSelectOptions {
  customId: string;
  placeholder?: string;
  minValues?: number;
  maxValues?: number;
  disabled?: boolean;
}

// Un'action row contiene O fino a 5 bottoni O esattamente un menu: i due tipi
// di select condividono quindi lo stesso budget di righe.
type AnySelectMenuBuilder = StringSelectMenuBuilder | UserSelectMenuBuilder;

class ButtonEmbedBuilder extends BasicEmbedBuilder {
  private readonly buttonRows: ActionRowBuilder<ButtonBuilder>[] = [];
  private readonly selectRows: ActionRowBuilder<AnySelectMenuBuilder>[] = [];
  private buttonCount = 0;
  private forceNewRow = false;

  button(options: ButtonOptions): this {
    const hasCustomId = Boolean(options.customId);
    const hasUrl = Boolean(options.url);

    if (hasCustomId === hasUrl) {
      throw new InvalidButtonConfigError(
        `"${options.label}" must have exactly one of customId or url, not both/neither.`,
      );
    }

    if (this.buttonCount >= MAX_BUTTONS_TOTAL) {
      throw new TooManyButtonsError();
    }

    const builder = new ButtonBuilder()
      .setLabel(truncate(options.label, Limits.ButtonLabel))
      .setDisabled(options.disabled ?? false);
    if (options.emoji) builder.setEmoji(options.emoji);

    if (hasUrl) {
      // options.url e' garantito definito qui: hasUrl === Boolean(options.url).
      builder.setStyle(ButtonStyle.Link).setURL(options.url as string);
    } else {
      builder.setStyle(options.style ?? ButtonStyle.Secondary).setCustomId(assertCustomId(options.customId as string));
    }

    this.appendButton(builder);
    return this;
  }

  /**
   * Manda il prossimo bottone a capo anche se la riga corrente non e' piena:
   * i bottoni si impacchettano a 5 per riga, ma su un pannello la riga e'
   * l'unico raggruppamento visivo disponibile (azioni vs navigazione).
   */
  newRow(): this {
    this.forceNewRow = true;
    return this;
  }

  select(options: SelectOptions): this {
    if (options.options.length === 0) {
      throw new InvalidSelectConfigError(`"${options.customId}" has no options: Discord requires at least one.`);
    }
    if (options.options.length > Limits.SelectOptions) {
      throw new InvalidSelectConfigError(
        `"${options.customId}" has ${options.options.length} options, the maximum is ${Limits.SelectOptions}.`,
      );
    }
    this.assertRowAvailable();

    const menu = new StringSelectMenuBuilder()
      .setCustomId(assertCustomId(options.customId))
      .setDisabled(options.disabled ?? false)
      .addOptions(
        options.options.map((option) => {
          if (option.value.length > Limits.SelectOptionValue) {
            throw new InvalidSelectConfigError(
              `value "${option.value}" exceeds ${Limits.SelectOptionValue} characters.`,
            );
          }
          return {
            label: truncate(option.label, Limits.SelectOptionLabel),
            value: option.value,
            description: option.description ? truncate(option.description, Limits.SelectOptionDescription) : undefined,
            emoji: option.emoji,
            default: option.default,
          };
        }),
      );

    this.applySelectCommon(menu, options);
    this.selectRows.push(new ActionRowBuilder<AnySelectMenuBuilder>().addComponents(menu));
    return this;
  }

  /**
   * Select nativa di utenti: Discord risolve e valida l'utente lato client,
   * quindi non serve chiedere l'ID a mano in una modal (dove sarebbe testo
   * libero, da validare e sbagliabile).
   */
  userSelect(options: UserSelectOptions): this {
    this.assertRowAvailable();

    const menu = new UserSelectMenuBuilder()
      .setCustomId(assertCustomId(options.customId))
      .setDisabled(options.disabled ?? false);

    this.applySelectCommon(menu, options);
    this.selectRows.push(new ActionRowBuilder<AnySelectMenuBuilder>().addComponents(menu));
    return this;
  }

  private applySelectCommon(menu: AnySelectMenuBuilder, options: SelectOptions | UserSelectOptions): void {
    if (options.placeholder) menu.setPlaceholder(truncate(options.placeholder, Limits.SelectPlaceholder));
    if (options.minValues !== undefined) menu.setMinValues(options.minValues);
    if (options.maxValues !== undefined) menu.setMaxValues(options.maxValues);
  }

  private assertRowAvailable(): void {
    if (this.selectRows.length + this.buttonRows.length >= MAX_ACTION_ROWS) {
      throw new TooManyComponentRowsError();
    }
  }

  private appendButton(builder: ButtonBuilder): void {
    const lastRow = this.buttonRows.at(-1);
    if (!this.forceNewRow && lastRow && lastRow.components.length < MAX_BUTTONS_PER_ROW) {
      lastRow.addComponents(builder);
    } else {
      this.assertRowAvailable();
      this.buttonRows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(builder));
    }
    this.forceNewRow = false;
    this.buttonCount++;
  }

  build(): BaseMessageOptions {
    return { ...this.baseOptions(), components: [...this.buttonRows, ...this.selectRows] };
  }

  buildEphemeral(): InteractionReplyOptions {
    return { ...this.build(), flags: MessageFlags.Ephemeral };
  }
}

interface TextInputOptions {
  customId: string;
  label: string;
  style?: TextInputStyle;
  placeholder?: string;
  value?: string;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
}

/**
 * Modal con gli stessi limiti applicati agli embed. Esiste perche' i modal
 * costruiti a mano con i builder di discord.js sfuggivano a ogni controllo: una
 * label di 53 caratteri (il massimo e' 45) faceva lanciare setLabel e l'utente
 * vedeva solo "interazione fallita".
 */
class ModalFormBuilder {
  private readonly modal = new ModalBuilder();
  private rowCount = 0;

  constructor(customId: string, title: string) {
    this.modal.setCustomId(assertCustomId(customId)).setTitle(truncate(title, Limits.ModalTitle));
  }

  input(options: TextInputOptions): this {
    if (this.rowCount >= Limits.ModalRows) throw new TooManyComponentRowsError();

    const input = new TextInputBuilder()
      .setCustomId(assertCustomId(options.customId))
      .setLabel(truncate(options.label, Limits.InputLabel))
      .setStyle(options.style ?? TextInputStyle.Short)
      .setRequired(options.required ?? true);

    // Il placeholder regge 100 caratteri contro i 45 della label: e' li' che va
    // messo il dettaglio lungo (esempi, formati ammessi).
    if (options.placeholder) input.setPlaceholder(truncate(options.placeholder, Limits.InputPlaceholder));
    if (options.value) input.setValue(truncate(options.value, Limits.InputValue));
    if (options.minLength !== undefined) input.setMinLength(options.minLength);
    if (options.maxLength !== undefined) input.setMaxLength(options.maxLength);

    this.modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    this.rowCount++;
    return this;
  }

  build(): ModalBuilder {
    if (this.rowCount === 0) throw new EmptyModalError();
    return this.modal;
  }
}

export class EmbedService {
  static basic(): StandardEmbedBuilder {
    return new StandardEmbedBuilder();
  }

  /** Unico modo di costruire un modal: i limiti sono applicati qui, una volta sola. */
  static modal(customId: string, title: string): ModalFormBuilder {
    return new ModalFormBuilder(customId, title);
  }

  static buttons(): ButtonEmbedBuilder {
    return new ButtonEmbedBuilder();
  }

  static success(description: string, title = "Done"): StandardEmbedBuilder {
    return EmbedService.preset(Colors.Success, title, description);
  }

  static error(description: string, title = "Error"): StandardEmbedBuilder {
    return EmbedService.preset(Colors.Error, title, description);
  }

  static warning(description: string, title = "Warning"): StandardEmbedBuilder {
    return EmbedService.preset(Colors.Warning, title, description);
  }

  static info(description: string, title = "Info"): StandardEmbedBuilder {
    return EmbedService.preset(Colors.Info, title, description);
  }

  static pending(description: string, title = "In Progress"): StandardEmbedBuilder {
    return EmbedService.preset(Colors.Pending, title, description);
  }

  private static preset(color: number, title: string, description: string): StandardEmbedBuilder {
    return new StandardEmbedBuilder().color(color).title(title).description(description).footer(BRAND_NAME).timestamp();
  }
}

export type {
  BasicEmbedBuilder,
  StandardEmbedBuilder,
  ButtonEmbedBuilder,
  ModalFormBuilder,
  TextInputOptions,
  ButtonOptions,
  SelectOption,
  SelectOptions,
  UserSelectOptions,
};
