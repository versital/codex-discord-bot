// Slash command definitions.
import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

export const PRESETS = {
  concise: 'Be direct and to the point. No filler, no pleasantries.',
  friendly: 'Be warm, casual and encouraging, like a helpful friend. Light emoji are fine.',
  teacher: 'Explain things step by step like a patient teacher, with simple examples, and check understanding at the end.',
  expert: 'Talk like a senior expert to a peer: precise and technical, no hand-holding.',
  pirate: 'Talk like a pirate, matey, but still give genuinely correct, useful answers.',
};

export const LENGTHS = {
  short: 'Keep answers very short: a few sentences at most.',
  normal: '',
  long: 'Give thorough, detailed answers when they help.',
};

export function buildCommands({ efforts, allowFast, allowDMs }) {
  const contexts = allowDMs
    ? [InteractionContextType.Guild, InteractionContextType.BotDM]
    : [InteractionContextType.Guild];
  const cmd = (name, description) => new SlashCommandBuilder()
    .setName(name).setDescription(description).setContexts(...contexts);
  const choices = (values) => values.map((v) => ({ name: v, value: v }));

  const commands = [
    cmd('ask', 'Ask Codex something')
      .addStringOption((o) => o.setName('prompt').setDescription('Your question').setRequired(true).setMaxLength(4000))
      .addAttachmentOption((o) => o.setName('file').setDescription('A file for Codex to look at'))
      .addBooleanOption((o) => o.setName('private').setDescription('Only you see the answer'))
      .addBooleanOption((o) => o.setName('new_chat').setDescription('Start a fresh chat for this question')),
    cmd('new', 'Start a new chat (the current one is kept in /chats)'),
    cmd('chats', 'List your recent chats and switch between them'),
    cmd('resume', 'Go back to one of your earlier chats')
      .addStringOption((o) => o.setName('chat').setDescription('Which chat').setRequired(true).setAutocomplete(true)),
    cmd('export', 'Download a chat as a text file')
      .addStringOption((o) => o.setName('chat').setDescription('Which chat (default: the current one)').setAutocomplete(true)),
    cmd('model', 'Show or change your model')
      .addStringOption((o) => o.setName('name').setDescription('Model to use, or "default"').setAutocomplete(true)),
    cmd('effort', 'Show or change how hard Codex thinks (lower is faster)')
      .addStringOption((o) => o.setName('level').setDescription('Reasoning effort').addChoices(...choices([...efforts, 'default']))),
    cmd('thinking', "Show or hide Codex's thinking above its answers")
      .addStringOption((o) => o.setName('mode').setDescription('show or hide').setRequired(true).addChoices(...choices(['show', 'hide']))),
    cmd('length', 'How long answers should be')
      .addStringOption((o) => o.setName('size').setDescription('Answer length').setRequired(true).addChoices(...choices(Object.keys(LENGTHS)))),
    new SlashCommandBuilder().setName('personality').setDescription('Your personal style for Codex').setContexts(...contexts)
      .addSubcommand((s) => s.setName('set').setDescription('Describe how Codex should talk to you')
        .addStringOption((o) => o.setName('text').setDescription('e.g. "casual, British spelling, no emoji"').setRequired(true).setMaxLength(1000)))
      .addSubcommand((s) => s.setName('preset').setDescription('Pick a ready-made personality')
        .addStringOption((o) => o.setName('name').setDescription('Preset').setRequired(true).addChoices(...choices(Object.keys(PRESETS)))))
      .addSubcommand((s) => s.setName('show').setDescription('Show your current personality'))
      .addSubcommand((s) => s.setName('clear').setDescription('Go back to the default personality')),
    cmd('settings', 'Show all your settings'),
    cmd('reset', 'Reset your settings to the defaults (keeps your chats)'),
    cmd('stop', 'Stop your running request'),
    cmd('retry', 'Ask your last message again'),
    cmd('usage', 'See how much you have used the bot'),
    cmd('forget', 'Delete your chats, settings and usage data'),
    cmd('help', 'How to use the bot'),
    new SlashCommandBuilder().setName('admin').setDescription('Bot owner tools').setContexts(...contexts)
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addSubcommand((s) => s.setName('status').setDescription('Version, uptime and load'))
      .addSubcommand((s) => s.setName('update').setDescription('Update the bot to the latest version')
        .addBooleanOption((o) => o.setName('check_only').setDescription("Only check, don't install"))
        .addAttachmentOption((o) => o.setName('zip').setDescription('Install this zip instead of the latest GitHub version')))
      .addSubcommand((s) => s.setName('rollback').setDescription('Go back to the previous version'))
      .addSubcommand((s) => s.setName('restart').setDescription('Restart the bot')),
  ];
  if (allowFast) {
    commands.push(cmd('fast', 'Fast mode: about 2x quicker answers, uses more of your quota')
      .addStringOption((o) => o.setName('mode').setDescription('on or off').setRequired(true).addChoices(...choices(['on', 'off']))));
  }
  return commands.map((c) => c.toJSON());
}
