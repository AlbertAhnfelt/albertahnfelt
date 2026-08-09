/**
 * The command set, and the pure functions the prompt and the palette agree on.
 *
 * Names are English because that is what a command is — you type `git status`
 * in Swedish too. The descriptions are Swedish, like the rest of the site's
 * chrome. The Swedish names this started with are kept as aliases so nothing
 * that was learned yesterday stops working.
 *
 * No command reaches the Worker. `vault` filters titles the page is already
 * allowed to list; the rest only move things around on screen.
 */

export type CommandAction = 'new' | 'clear' | 'vault' | 'verbose' | 'help'

export type Command = {
  name: string
  /** Shown after the name once it is complete, e.g. `/vault <fras>`. */
  arg?: string
  aliases?: string[]
  help: string
  action: CommandAction
}

export const COMMANDS: Command[] = [
  { name: '/new', aliases: ['/ny'], help: 'börja en ny konversation', action: 'new' },
  {
    name: '/clear',
    aliases: ['/rensa'],
    help: 'rensa rutan — ctrl+l gör samma sak',
    action: 'clear',
  },
  { name: '/vault', arg: '<fras>', aliases: ['/valv'], help: 'sök titlar i valvet', action: 'vault' },
  { name: '/verbose', help: 'visa eller göm verktygsanrop', action: 'verbose' },
  { name: '/help', aliases: ['/hjälp', '/?'], help: 'den här listan', action: 'help' },
]

/** True if the line is meant for the terminal rather than for Abbe. */
export function isCommand(value: string): boolean {
  return value.startsWith('/')
}

/** The first word and everything after it. */
export function splitCommand(text: string): { head: string; rest: string } {
  const space = text.indexOf(' ')
  return {
    head: (space === -1 ? text : text.slice(0, space)).toLowerCase(),
    rest: space === -1 ? '' : text.slice(space + 1),
  }
}

/** The command a head names exactly, by canonical name or alias. */
export function findCommand(head: string): Command | null {
  const wanted = head.toLowerCase()
  return COMMANDS.find((c) => c.name === wanted || c.aliases?.includes(wanted)) ?? null
}

/**
 * What the palette should offer for a line being typed.
 *
 * Empty once there is a space: by then the command is chosen and you are typing
 * its argument, and a list of alternatives is just something covering the view.
 * Aliases match too, so `/ny` finds `/new` — but what is offered is the
 * canonical name, which is what you should end up learning.
 */
export function matchCommands(value: string): Command[] {
  if (!isCommand(value) || value.includes(' ')) return []
  const typed = value.toLowerCase()
  if (typed === '/') return COMMANDS
  return COMMANDS.filter(
    (c) => c.name.startsWith(typed) || c.aliases?.some((a) => a.startsWith(typed)),
  )
}

/**
 * The dim rest of the command being typed, or ''.
 *
 * Only with the caret at the very end — a suggestion trailing text you are
 * editing in the middle of is noise — and only when exactly one command
 * matches, because a ghost that guesses between two is worse than none. Once
 * the name is complete it becomes the argument hint instead.
 */
export function completionFor(value: string, atEnd: boolean): string {
  if (!atEnd || !isCommand(value)) return ''

  const exact = findCommand(value.toLowerCase())
  if (exact && !value.includes(' ')) return exact.arg ? ` ${exact.arg}` : ''

  if (value.includes(' ')) return ''

  const matches = matchCommands(value)
  if (matches.length !== 1) return ''

  // Only completes the canonical name. Typing an alias far enough to be unique
  // still completes to the real name rather than finishing the alias.
  const name = matches[0].name
  return name.startsWith(value.toLowerCase()) ? name.slice(value.length) : ''
}
