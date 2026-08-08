import {
  ButtonStyle,
  TextInputStyle,
  MessageFlags,
  GuildMember,
  type ButtonInteraction,
  type InteractionReplyOptions,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { VerificationPlatform } from "@prisma/client";
import { TicketType } from "../domain/ticket-state.js";
import { DomainError, NotInGuildError } from "../domain/errors.js";
import { Tier, parseTier } from "../services/auth-state.js";
import { Colors, EmbedService } from "../services/embed-service.js";
import { InteractionRouter } from "./router.js";

const OPEN_TYPE_BY_PARAM: Record<string, TicketType> = {
  verification: TicketType.Verification,
  commission: TicketType.Commission,
  support: TicketType.Support,
  "priority-support": TicketType.PrioritySupport,
  report: TicketType.Report,
};

interface FormField {
  customId: string;
  label: string;
  style: TextInputStyle;
  required: boolean;
}

type NonVerificationType = Exclude<TicketType, TicketType.Verification>;

/** Campi della form mostrata all'apertura di ogni tipo di ticket (tranne VERIFICATION, che ha la sua). */
const OPEN_FORM_FIELDS: Record<NonVerificationType, readonly FormField[]> = {
  [TicketType.Commission]: [
    { customId: "description", label: "Description of the work requested", style: TextInputStyle.Paragraph, required: true },
    { customId: "budget", label: "Estimated budget", style: TextInputStyle.Short, required: false },
    { customId: "deadline", label: "Desired deadline", style: TextInputStyle.Short, required: false },
  ],
  [TicketType.Support]: [
    { customId: "product", label: "Product concerned", style: TextInputStyle.Short, required: false },
    { customId: "description", label: "Describe the issue", style: TextInputStyle.Paragraph, required: true },
  ],
  [TicketType.PrioritySupport]: [
    { customId: "product", label: "Product concerned", style: TextInputStyle.Short, required: true },
    { customId: "description", label: "Describe the issue", style: TextInputStyle.Paragraph, required: true },
  ],
  [TicketType.Report]: [
    { customId: "target", label: "Who/what are you reporting", style: TextInputStyle.Short, required: true },
    { customId: "description", label: "Detailed description", style: TextInputStyle.Paragraph, required: true },
  ],
};

const OPEN_MODAL_TITLES: Record<NonVerificationType, string> = {
  [TicketType.Commission]: "Commission Request",
  [TicketType.Support]: "Support Request",
  [TicketType.PrioritySupport]: "Priority Support",
  [TicketType.Report]: "New Report",
};

const PLATFORM_LABEL: Record<VerificationPlatform, string> = {
  [VerificationPlatform.MCMODELS]: "MCModels",
  [VerificationPlatform.BUILTBYBIT]: "BuiltByBit",
  [VerificationPlatform.POLYMART]: "Polymart",
  [VerificationPlatform.WEBSITE]: "Official website",
  [VerificationPlatform.OTHER]: "Other",
};

/**
 * La piattaforma arriva da un menu, non piu' da testo libero: prima un refuso
 * ("mcmodel") diventava silenziosamente OTHER e lo staff revisionava un dato
 * sbagliato. Qui si valida comunque, perche' il valore viaggia nel customId e
 * quindi non e' fidato.
 */
function parsePlatform(raw: string | undefined): VerificationPlatform | undefined {
  if (!raw) return undefined;
  return Object.values(VerificationPlatform).find((platform) => platform === raw);
}

/** DomainError ha gia' un messaggio in italiano pensato per l'utente finale. */
async function replyWithError(
  interaction: ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction,
  error: unknown,
): Promise<void> {
  const description = error instanceof DomainError ? error.message : "An unexpected error occurred.";
  const payload: InteractionReplyOptions = EmbedService.error(description).buildEphemeral();

  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(payload);
  } else {
    await interaction.reply(payload);
  }
}

function requireGuildMember(member: ButtonInteraction["member"]): GuildMember {
  if (!(member instanceof GuildMember)) {
    throw new NotInGuildError();
  }
  return member;
}

export function registerTicketHandlers(router: InteractionRouter): void {
  // --- Apertura ticket dal pannello -------------------------------------
  router.registerButton("ticket:open", async (interaction, [typeParam]) => {
    const type = typeParam ? OPEN_TYPE_BY_PARAM[typeParam] : undefined;
    if (!type) {
      await interaction.reply({ content: "Unknown ticket type.", flags: MessageFlags.Ephemeral });
      return;
    }

    // La verifica chiede prima la piattaforma: un menu non si puo' mettere in
    // un modal, quindi il passaggio e' separato (e la form resta piu' corta).
    if (type === TicketType.Verification) {
      await interaction.reply(
        EmbedService.buttons()
          .color(Colors.Info)
          .title("Verify Purchase")
          .description("Which platform did you purchase from? After you choose, I will ask for the details.")
          .select({
            customId: "ticket:verify-platform",
            placeholder: "Choose the platform",
            options: Object.values(VerificationPlatform).map((platform) => ({
              label: PLATFORM_LABEL[platform],
              value: platform,
            })),
          })
          .buildEphemeral(),
      );
      return;
    }

    // Ogni altro tipo ha comunque una sua form (piu' corta), cosi' il canale
    // parte gia' con le informazioni di base invece di un canale vuoto.
    const modal = EmbedService.modal(`ticket:open-modal:${typeParam}`, OPEN_MODAL_TITLES[type]);
    for (const field of OPEN_FORM_FIELDS[type]) {
      modal.input({
        customId: field.customId,
        label: field.label,
        style: field.style,
        required: field.required,
      });
    }

    await interaction.showModal(modal.build());
  });

  router.registerSelect("ticket:verify-platform", async (interaction) => {
    const platform = parsePlatform(interaction.values[0]);
    if (!platform) {
      await interaction.reply(EmbedService.error("Platform not recognized.").buildEphemeral());
      return;
    }

    await interaction.showModal(
      EmbedService.modal(`ticket:verify-modal:${platform}`, `Verification on ${PLATFORM_LABEL[platform]}`)
        .input({
          customId: "username",
          label: "Your username on that platform",
          placeholder: `How your profile appears on ${PLATFORM_LABEL[platform]}`,
        })
        .input({ customId: "product", label: "Product purchased" })
        .input({
          customId: "purchaseDate",
          label: "Purchase date (optional)",
          placeholder: "DD/MM/YYYY",
          required: false,
        })
        .build(),
    );
  });

  router.registerModal("ticket:open-modal", async (interaction, [typeParam]) => {
    const rawType = typeParam ? OPEN_TYPE_BY_PARAM[typeParam] : undefined;
    if (!rawType || rawType === TicketType.Verification) return;
    const type: NonVerificationType = rawType;

    try {
      const author = requireGuildMember(interaction.member);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const details = OPEN_FORM_FIELDS[type]
        .map((field) => ({ label: field.label, value: interaction.fields.getTextInputValue(field.customId).trim() }))
        .filter((field) => field.value.length > 0);

      const subject = details[0]?.value.slice(0, 100);

      const ticket = await interaction.client.services.ticket.openTicket({ type, author, subject, details });
      await interaction.editReply({ content: `Ticket opened: <#${ticket.channelId}>` });
    } catch (error) {
      await replyWithError(interaction, error);
    }
  });

  router.registerModal("ticket:verify-modal", async (interaction, [platformParam]) => {
    const platform = parsePlatform(platformParam);
    if (!platform) {
      await interaction.reply(EmbedService.error("Platform not recognized.").buildEphemeral());
      return;
    }

    try {
      const author = requireGuildMember(interaction.member);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const platformUsername = interaction.fields.getTextInputValue("username");
      const product = interaction.fields.getTextInputValue("product");
      const rawDate = interaction.fields.getTextInputValue("purchaseDate");
      const purchaseDate = parseItalianDate(rawDate);

      const ticket = await interaction.client.services.ticket.openVerificationTicket(author, {
        platform,
        platformUsername,
        product,
        purchaseDate,
      });

      await interaction.editReply({ content: `Verification ticket opened: <#${ticket.channelId}>` });
    } catch (error) {
      await replyWithError(interaction, error);
    }
  });

  // --- Gestione staff -----------------------------------------------------
  router.registerButton("ticket:claim", async (interaction, [ticketId]) => {
    await handleStaffAction(interaction, ticketId, (staff, id) => interaction.client.services.ticket.claim(id, staff));
  });

  router.registerButton("ticket:resolve", async (interaction, [ticketId]) => {
    await handleStaffAction(interaction, ticketId, (staff, id) => interaction.client.services.ticket.resolve(id, staff));
  });

  router.registerButton("ticket:reopen", async (interaction, [ticketId]) => {
    await handleStaffAction(interaction, ticketId, (staff, id) => interaction.client.services.ticket.reopen(id, staff));
  });

  router.registerButton("ticket:remove", async (interaction, [ticketId]) => {
    await handleStaffAction(interaction, ticketId, (staff, id) => interaction.client.services.ticket.remove(id, staff));
  });

  router.registerButton("ticket:close", async (interaction, [ticketId]) => {
    if (!ticketId) return;
    const confirm = EmbedService.buttons()
      .color(Colors.Warning)
      .title("Confirm closing?")
      .description("A transcript will be generated and the channel will be deleted after a configured delay.")
      .button({ label: "Confirm Closing", style: ButtonStyle.Danger, customId: `ticket:close-confirm:${ticketId}` })
      .button({ label: "Cancel", style: ButtonStyle.Secondary, customId: `ticket:close-cancel:${ticketId}` })
      .buildEphemeral();

    await interaction.reply(confirm);
  });

  router.registerButton("ticket:close-confirm", async (interaction, [ticketId]) => {
    await handleStaffAction(interaction, ticketId, (staff, id) => interaction.client.services.ticket.close(id, staff));
  });

  router.registerButton("ticket:close-cancel", async (interaction) => {
    await interaction.update({ content: "Closing canceled.", embeds: [], components: [] });
  });

  // --- Verifica: approvazione / rifiuto -----------------------------------
  router.registerButton("verify:approve", async (interaction, [ticketId]) => {
    if (!ticketId) return;
    const select = EmbedService.buttons()
      .color(Colors.Info)
      .title("Select the Tier")
      .description("Which tier do you want to verify this user with?")
      .select({
        customId: `verify:tier-select:${ticketId}`,
        placeholder: "Choose a tier",
        options: [
          { label: "Customer", value: Tier.Customer },
          { label: "Premium", value: Tier.Premium },
        ],
      })
      .buildEphemeral();

    await interaction.reply(select);
  });

  router.registerSelect("verify:tier-select", async (interaction, [ticketId]) => {
    if (!ticketId) return;
    try {
      const staff = requireGuildMember(interaction.member);
      await interaction.deferUpdate();
      const tier = parseTier(interaction.values[0]);
      if (!tier) {
        await interaction.editReply({ content: "Tier not recognized.", embeds: [], components: [] });
        return;
      }
      await interaction.client.services.ticket.approveVerification(ticketId, staff, tier);
      await interaction.editReply({ content: "Verification approved.", embeds: [], components: [] });
    } catch (error) {
      await replyWithError(interaction, error);
    }
  });

  router.registerButton("verify:reject", async (interaction, [ticketId]) => {
    if (!ticketId) return;
    await interaction.showModal(
      EmbedService.modal(`verify:reject-modal:${ticketId}`, "Reason for Rejection")
        .input({
          customId: "reason",
          label: "Reason (will be sent to the user)",
          style: TextInputStyle.Paragraph,
        })
        .build(),
    );
  });

  router.registerModal("verify:reject-modal", async (interaction, [ticketId]) => {
    if (!ticketId) return;
    try {
      const staff = requireGuildMember(interaction.member);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const reason = interaction.fields.getTextInputValue("reason");
      await interaction.client.services.ticket.rejectVerification(ticketId, staff, reason);
      await interaction.editReply({ content: "Verification rejected." });
    } catch (error) {
      await replyWithError(interaction, error);
    }
  });

  async function handleStaffAction(
    interaction: ButtonInteraction,
    ticketId: string | undefined,
    action: (staff: GuildMember, ticketId: string) => Promise<void>,
  ): Promise<void> {
    if (!ticketId) return;
    try {
      const staff = requireGuildMember(interaction.member);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await action(staff, ticketId);
      await interaction.editReply({ content: "Done." });
    } catch (error) {
      await replyWithError(interaction, error);
    }
  }
}

function parseItalianDate(raw: string): Date | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (!match) return undefined;

  const [, day, month, year] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  return Number.isNaN(date.getTime()) ? undefined : date;
}
