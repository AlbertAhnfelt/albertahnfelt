<script lang="ts">
  /**
   * The Abbe terminal.
   *
   * Mounted client:only, so none of this — not the heading, not the prompt —
   * exists in the static HTML an anonymous visitor receives. What ships is the
   * site's ordinary 404, which is what /abbe always claimed to be.
   *
   * The Worker owns the conversation. This holds only what is on screen: the
   * transcript is read back from D1 by id, and nothing here is ever replayed to
   * the model. State lives in runes and the DOM is what Svelte makes of it,
   * which is the difference that matters — every row below is in a template, so
   * the scoped styles reach it.
   */

  import { onMount } from 'svelte'
  import Palette from './Palette.svelte'
  import Prompt from './Prompt.svelte'
  import Rail from './Rail.svelte'
  import Transcript from './Transcript.svelte'
  import {
    fetchChats,
    fetchMe,
    fetchTranscript,
    fetchVaultPages,
    isConversationId,
    streamChat,
  } from '../../lib/abbe/api'
  import {
    COMMANDS,
    type Command,
    completionFor,
    findCommand,
    isCommand,
    matchCommands,
    splitCommand,
  } from '../../lib/abbe/commands'
  import type { ChatSummary, Row, SysRow, ToolEvent, VaultPage } from '../../lib/abbe/types'

  /* ------------------------------------------------------------------ state */

  let chats = $state<ChatSummary[]>([])
  let currentId = $state<string | null>(null)
  let rows = $state<Row[]>([])
  let model = $state<string | null>(null)
  let verbose = $state(false)

  let input = $state('')
  let atEnd = $state(true)
  let promptRef = $state<Prompt>()
  let bottom = $state<HTMLElement>()

  /** Recall, ↑/↓. Seeded from the transcript, so it survives a reload. */
  let past = $state<string[]>([])
  let pastAt: number | null = null
  let draft = ''

  /**
   * Interrupting a turn. The controller only stops *this* side reading: the
   * Worker runs the turn under waitUntil and stores whatever it generated, so
   * an abort leaves the screen and the stored transcript agreeing.
   */
  let pending = $state(false)
  let controller: AbortController | null = null
  let aborted = false

  let statusLine = $state<string | null>(null)
  let elapsed = $state(0)
  let frame = $state(0)

  let paletteAt = $state(0)
  let vaultPages: VaultPage[] | null = null

  let nextRowId = 0
  const rowId = () => ++nextRowId

  /* -------------------------------------------------------------- derived */

  const palette = $derived(matchCommands(input))
  const ghost = $derived(completionFor(input, atEnd))

  /** Braille, because it turns in place instead of jittering the line width. */
  const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

  /** Past this many seconds the spinner warms, to say it is still working. */
  const SLOW_AFTER_S = 10

  const bootLine = $derived(
    [
      'abbe',
      model,
      chats.length === 1 ? '1 konversation' : `${chats.length} konversationer`,
      verbose ? 'verbose' : null,
    ]
      .filter(Boolean)
      .join('   ·   '),
  )

  // Keep the highlighted row inside the list as it narrows under you.
  $effect(() => {
    if (paletteAt >= palette.length) paletteAt = 0
  })

  /* ------------------------------------------------------------- plumbing */

  function nudge() {
    bottom?.scrollIntoView({ block: 'nearest' })
  }

  /**
   * Rows are addressed by id, never by holding on to one.
   *
   * `rows` is a deep $state proxy, and a reference into it is only good until
   * the array is rearranged — which happens on every turn, because tool traces
   * are spliced in above the reply they belong to. Holding the object worked
   * for the first reply of a session and silently stopped working for the
   * second: its streaming cursor never came off. An id survives a splice.
   */
  function say(role: 'me' | 'abbe', text: string, opts: { partial?: boolean; at?: number } = {}) {
    const id = rowId()
    rows.push({
      kind: 'said',
      id,
      role,
      text,
      at: opts.at ?? Date.now(),
      partial: opts.partial ?? false,
      streaming: false,
    })
    nudge()
    return id
  }

  /** Change a row in place, wherever it has ended up. */
  function patch(id: number, changes: { text?: string; partial?: boolean; streaming?: boolean }) {
    const at = rows.findIndex((row) => row.id === id)
    if (at === -1) return
    Object.assign(rows[at], changes)
  }

  function sys(heading: string, entries: SysRow[]) {
    rows.push({ kind: 'sys', id: rowId(), heading, rows: entries })
    nudge()
  }

  /* -------------------------------------------------------------- history */

  async function loadChats() {
    try {
      chats = await fetchChats()
    } catch {
      // A rail that failed to load is a rail that is empty. The chat itself
      // does not depend on it, so there is nothing to say about this.
    }
  }

  /** Move the conversation just spoken in to the front, where it belongs. */
  function touch(id: string) {
    const at = chats.findIndex((item) => item.id === id)
    if (at === -1) return
    const [item] = chats.splice(at, 1)
    chats.unshift({ ...item, updated_at: Date.now() })
  }

  /* -------------------------------------------------------------- routing */

  function idFromUrl(): string | null {
    const rest = window.location.pathname.replace(/^\/abbe\/?/, '')
    return isConversationId(rest) ? rest : null
  }

  async function openChat(id: string) {
    try {
      const { messages, tools } = await fetchTranscript(id)

      // Grouped by the reply each round of calls led to, so the trace can be
      // printed where it happened rather than in a heap at the end.
      const byMessage = new Map<number, ToolEvent[]>()
      for (const event of tools) {
        if (event.message_id == null) continue
        const list = byMessage.get(event.message_id)
        if (list) list.push(event)
        else byMessage.set(event.message_id, [event])
      }

      const next: Row[] = []
      const recall: string[] = []

      for (const message of messages) {
        // Tools ran before the answer they produced, so they print above it.
        for (const tool of byMessage.get(message.id) ?? []) {
          next.push({ kind: 'tool', id: rowId(), tool })
        }
        next.push({
          kind: 'said',
          id: rowId(),
          role: message.role === 'user' ? 'me' : 'abbe',
          text: message.text,
          at: message.created_at,
          partial: message.partial,
          streaming: false,
        })
        // What ↑ walks back through. Seeded from the transcript, so recall
        // works on a conversation this tab has never spoken in.
        if (message.role === 'user') recall.push(message.text)
      }

      rows = next
      past = recall
      pastAt = null
    } catch {
      rows = []
      statusLine = 'kunde inte läsa konversationen.'
    }
  }

  async function route() {
    const id = idFromUrl()
    // Already showing this one. Matters because every reply replaces the URL,
    // and re-reading the transcript we just wrote would be a visible flicker.
    if (id === currentId) return

    currentId = id
    rows = []
    statusLine = null
    // A fresh conversation has nothing to recall, and carrying the previous
    // one's messages over would put words in this one's history.
    past = []
    pastAt = null

    if (id) await openChat(id)
    nudge()
  }

  function go(id: string) {
    const href = `/abbe/${id}`
    if (href === window.location.pathname) return
    window.history.pushState({}, '', href)
    void route()
  }

  function startNew() {
    if (currentId === null) return promptRef?.focus()
    window.history.pushState({}, '', '/abbe')
    void route()
    promptRef?.focus()
  }

  /* ------------------------------------------------------------ commands */

  function clearScreen() {
    rows = []
    statusLine = null
    nudge()
  }

  function setVerbose(on: boolean) {
    verbose = on
    try {
      window.localStorage.setItem('abbe:verbose', on ? '1' : '0')
    } catch {
      // Private browsing, or storage full. The toggle still works for this
      // page; it just will not be remembered.
    }
  }

  /** Titles only, and only fetched the first time the vault is searched. */
  async function vaultSearch(query: string) {
    const q = query.trim().toLowerCase()
    if (!q) {
      sys('valv', [{ key: '/vault', value: 'ange en sökfras, t.ex. /vault loggning' }])
      return
    }

    if (!vaultPages) {
      try {
        vaultPages = await fetchVaultPages()
      } catch {
        statusLine = 'kunde inte läsa valvet.'
        return
      }
    }

    const hits = vaultPages
      .filter((p) => p.title.toLowerCase().includes(q) || p.folder.toLowerCase().includes(q))
      .slice(0, 12)

    if (hits.length === 0) {
      sys(`valv · ${q}`, [{ key: '', value: 'inga träffar.' }])
      return
    }

    sys(
      `valv · ${hits.length} träffar`,
      hits.map((page) => ({
        key: page.folder || '/',
        value: page.title,
        href: `/vault/${page.path.split('/').map(encodeURIComponent).join('/')}`,
      })),
    )
  }

  function showHelp() {
    sys(
      'kommandon',
      COMMANDS.map((c) => ({ key: c.arg ? `${c.name} ${c.arg}` : c.name, value: c.help })),
    )
    sys('tangenter', [
      { key: '↑ ↓', value: 'tidigare meddelanden — eller val i listan' },
      { key: 'tab', value: 'fyll i kommandot' },
      { key: 'esc', value: 'stäng listan, eller avbryt ett svar som skrivs' },
      { key: 'ctrl+l', value: 'rensa rutan' },
      { key: 'skift+enter', value: 'ny rad' },
    ])
  }

  async function runCommand(text: string) {
    const { head, rest } = splitCommand(text)
    const command = findCommand(head)
    if (!command) {
      statusLine = `okänt kommando: ${head} — /help visar listan.`
      return
    }

    statusLine = null
    switch (command.action) {
      case 'new':
        startNew()
        break
      case 'clear':
        clearScreen()
        break
      case 'vault':
        await vaultSearch(rest)
        break
      case 'verbose':
        setVerbose(!verbose)
        break
      case 'help':
        showHelp()
        break
    }
  }

  /**
   * Choosing from the list. A command that takes an argument is filled in and
   * left for you to finish rather than run empty — that is what you meant by
   * highlighting it.
   */
  function pick(command: Command) {
    if (command.arg) {
      promptRef?.replace(`${command.name} `)
      promptRef?.focus()
      return
    }
    promptRef?.replace('')
    void submit(command.name)
    promptRef?.focus()
  }

  /* ------------------------------------------------------------ the turn */

  async function submit(text: string) {
    const trimmed = text.trim()
    if (!trimmed || pending) return

    // Recall holds everything typed at this prompt, commands included — they
    // are the lines most worth getting back without retyping.
    past.push(trimmed)
    pastAt = null
    draft = ''

    // A command never reaches the Worker and never becomes a turn: it is the
    // terminal talking to itself.
    if (isCommand(trimmed)) {
      await runCommand(trimmed)
      return
    }

    say('me', trimmed)
    statusLine = null

    pending = true
    aborted = false
    controller = new AbortController()

    const began = Date.now()
    elapsed = 0
    const ticker = window.setInterval(() => {
      elapsed = Math.floor((Date.now() - began) / 1000)
      frame = (frame + 1) % FRAMES.length
    }, 120)

    // Empty, with `streaming` doing the talking — a blinking block where the
    // answer will appear, rather than the word "thinking" sitting there as
    // though Abbe had said it.
    const replyId = say('abbe', '')
    patch(replyId, { streaming: true })

    // Captured now: the reply belongs to the conversation that was open when it
    // was asked for, even if something navigates while it streams.
    const asked = currentId
    let text_ = ''

    try {
      for await (const event of streamChat(asked, trimmed, controller.signal)) {
        if (event.error) throw new Error(event.error)

        // First line of every stream. On a fresh conversation this is how the
        // page learns the id the Worker minted, and the URL becomes shareable
        // without a navigation.
        if (event.conversation) {
          if (!currentId) {
            const opened = event.conversation
            currentId = opened.id
            window.history.replaceState({}, '', `/abbe/${currentId}`)

            // Replace rather than prepend. The rail is a keyed list, and two
            // rows sharing a key is fatal in a way it never was when this was
            // built by hand: Svelte throws mid-update and stops repainting the
            // whole terminal, so a stream that is still arriving looks frozen.
            // The Worker should never hand back an id already in the list, but
            // "should never" is not worth the entire surface locking up.
            chats = [
              { id: opened.id, title: opened.title, updated_at: Date.now() },
              ...chats.filter((chat) => chat.id !== opened.id),
            ]
          }
          continue
        }

        // Printed above the reply, where it happened. Hidden unless verbose,
        // but rendered either way so turning it on reveals the calls behind
        // answers already on screen.
        if (event.tool) {
          const at = rows.findIndex((row) => row.id === replyId)
          rows.splice(at === -1 ? rows.length : at, 0, {
            kind: 'tool',
            id: rowId(),
            tool: event.tool,
          })
          continue
        }

        if (event.delta === undefined) continue
        text_ += event.delta
        patch(replyId, { text: text_ })
        nudge()
      }

      if (!text_) throw new Error('empty')
      if (asked) touch(asked)
    } catch {
      // Whatever did arrive is kept and marked, because the Worker stores the
      // fragment too — overwriting it here would leave the page saying
      // something different from what a reload will show. A turn that produced
      // nothing at all leaves no Abbe line to explain itself.
      if (text_) patch(replyId, { partial: true })
      else rows = rows.filter((row) => row.id !== replyId)

      // An interruption is not a failure. The Worker keeps going under
      // waitUntil and stores what it made, so this says what happened rather
      // than blaming something.
      statusLine = aborted ? 'avbruten.' : 'något gick fel.'
    } finally {
      window.clearInterval(ticker)
      pending = false
      controller = null
      patch(replyId, { streaming: false })
      nudge()
      promptRef?.focus()
    }
  }

  /* ------------------------------------------------------------ keyboard */

  function onkeydown(event: KeyboardEvent) {
    // First, because it is the one key that has to work while the prompt is
    // read-only and everything below is refusing input.
    if (event.key === 'Escape') {
      if (palette.length > 0) {
        event.preventDefault()
        // Closing the list means no longer typing a command.
        promptRef?.replace('')
        return
      }
      if (!controller) return
      event.preventDefault()
      aborted = true
      controller.abort()
      return
    }

    if (event.key.toLowerCase() === 'l' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      clearScreen()
      return
    }

    // While the list is open the arrows belong to it, not to recall.
    if (palette.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        paletteAt = (paletteAt + 1) % palette.length
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        paletteAt = (paletteAt - 1 + palette.length) % palette.length
        return
      }
      if (event.key === 'Tab') {
        event.preventDefault()
        const chosen = palette[paletteAt]
        promptRef?.replace(chosen.arg ? `${chosen.name} ` : chosen.name)
        return
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        pick(palette[paletteAt])
        return
      }
    }

    if (event.key === 'Tab' && ghost) {
      event.preventDefault()
      // The argument hint is a label, not text to insert — completing `/vault`
      // should leave you ready to type the phrase, not the word "<fras>".
      promptRef?.replace(input + (ghost.trim().startsWith('<') ? ' ' : ghost))
      return
    }

    // Recall only from the edge of the text, so arrows still move within a
    // message that happens to span several lines.
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const el = event.target as HTMLTextAreaElement
      const caret = el.selectionStart ?? 0
      const up = event.key === 'ArrowUp'
      const atEdge = up
        ? !input.slice(0, caret).includes('\n')
        : !input.slice(el.selectionEnd ?? caret).includes('\n')
      if (!atEdge) return

      if (up) {
        if (past.length === 0) return
        event.preventDefault()
        // Stepping in for the first time: keep whatever was half-typed, so
        // coming back down returns it rather than an empty line.
        if (pastAt === null) {
          draft = input
          pastAt = past.length
        }
        pastAt = Math.max(0, pastAt - 1)
        promptRef?.replace(past[pastAt])
        return
      }

      if (pastAt === null) return
      event.preventDefault()
      pastAt += 1
      if (pastAt >= past.length) {
        pastAt = null
        promptRef?.replace(draft)
      } else {
        promptRef?.replace(past[pastAt])
      }
    }
  }

  /* --------------------------------------------------------------- session */

  const show = (state: 'out' | 'in') => {
    document.documentElement.dataset.session = state
  }

  /**
   * The page ships as a 404, title included, so there is no moment where the
   * tab says "Abbe" to someone who is not signed in. Both names come from the
   * head (see Layout.astro), which is the only place either is spelled out.
   */
  function title(state: 'out' | 'in') {
    const root = document.documentElement
    const meta = document.querySelector<HTMLMetaElement>('meta[name="auth-title"]')

    if (state === 'in') {
      if (!meta || document.title === meta.content) return
      root.dataset.publicTitle = document.title
      document.title = meta.content
    } else if (root.dataset.publicTitle) {
      document.title = root.dataset.publicTitle
    }
  }

  let started = false

  function signedIn() {
    show('in')
    title('in')
    if (started) return
    started = true

    void route()
    void loadChats()
    promptRef?.focus()
  }

  onMount(() => {
    // Remembered across loads, because it is a preference about how much you
    // want to see rather than state belonging to a conversation.
    try {
      verbose = window.localStorage.getItem('abbe:verbose') === '1'
    } catch {
      verbose = false
    }

    const onpopstate = () => void route()
    window.addEventListener('popstate', onpopstate)

    // Dev only, and dead-code-eliminated from the production bundle: lets the
    // shell be looked at without a working Google login locally. It shows an
    // empty UI — there is still no vault content on this page to leak.
    if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('preview')) {
      signedIn()
      return () => window.removeEventListener('popstate', onpopstate)
    }

    // The head script has already painted from the hint cookie. Taking it at
    // its word here too is what makes the page usable immediately: the prompt
    // is wired up and focused now, rather than a round trip from now.
    if (document.documentElement.dataset.session === 'in') signedIn()

    // The authority, and the only thing that gets to be the last word. The
    // Worker deletes a stale hint on its way out of this call, so a session
    // that has been revoked cannot keep painting itself back in.
    fetchMe()
      .then((me) => {
        if (!me.ok) {
          show('out')
          title('out')
          return
        }
        if (me.model) model = me.model
        signedIn()
      })
      .catch(() => {
        // Offline, or the Worker is down. Whatever is on screen stays: a
        // dropped request is not evidence about the session, and there is
        // nothing on this page to protect — the chat endpoint does its own
        // checking, and will fail the same way this did.
      })

    return () => window.removeEventListener('popstate', onpopstate)
  })
</script>

<div class="shell">
  <Rail {chats} {currentId} onnew={startNew} onopen={go} />

  <div class="content">
    <section class="abbe">
      <!-- Clicking dead space drops you back on the prompt, unless you were
           selecting text to copy or aiming at a control. Not a focus trap: the
           handler is on a plain div and every control inside stays reachable
           by keyboard, so there is nothing here for a11y to route around. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        class="term"
        onclick={(event) => {
          const target = event.target as HTMLElement | null
          if (target?.closest('a, button, textarea')) return
          if (!window.getSelection()?.toString()) promptRef?.focus()
        }}
      >
        <h1>Abbe.</h1>

        <p class="boot">{bootLine}</p>

        <Transcript {rows} {verbose} />

        <Palette items={palette} selected={paletteAt} onpick={pick} />

        <Prompt
          bind:this={promptRef}
          bind:value={input}
          bind:atEnd
          busy={pending}
          {ghost}
          {onkeydown}
          onsubmit={() => {
            const text = input
            input = ''
            void submit(text)
          }}
        />

        <!-- Live state: the spinner, how long it has been going, and how to
             stop it. Warms past ten seconds to say it is still working. -->
        {#if pending}
          <p class="bar" class:slow={elapsed >= SLOW_AFTER_S}>
            {FRAMES[frame]}&nbsp;&nbsp;tänker… {elapsed}s&nbsp;&nbsp;·&nbsp;&nbsp;esc avbryter
          </p>
        {/if}

        <!-- Failures belong here, not in the transcript: a line labelled "Abbe"
             is something Abbe said, and the stream breaking is not. -->
        {#if statusLine}
          <p class="status">{statusLine}</p>
        {/if}

        <div bind:this={bottom}></div>
      </div>
    </section>
  </div>
</div>

<style>
  /* Narrow first: history above the chat, chat below it. */
  .shell {
    display: flex;
    flex-direction: column;
  }

  .content {
    display: flex;
    justify-content: center;
    padding: 2rem 1.5rem 0;
  }

  .abbe {
    width: 100%;
    max-width: 36rem;
    font-size: 1rem;
    line-height: 1.6;
  }

  /* The label column, shared by the transcript, the prompt, the tool trace and
     the palette. A custom property rather than a repeated measurement, because
     four components have to agree on it and they cannot see each other's
     scoped styles. */
  .term {
    --label: 5rem;
    --gap: 1.25rem;
    --me: #e2614f;
    --abbe: #7fa6ff;
  }

  h1 {
    font-size: 2.4rem;
    line-height: 1.2;
    margin-bottom: 0.6rem;
  }

  /* The system line under the heading: who is answering, how much history. */
  .boot {
    margin: 0 0 2.5rem;
    font-size: 0.75rem;
    letter-spacing: 0.04em;
    opacity: 0.3;
  }

  /* Aligned with the message column rather than the label column, so both read
     as remarks about the conversation and not as another speaker. */
  .status,
  .bar {
    margin: 0.25rem 0 0;
    padding-left: calc(var(--label) + var(--gap));
    opacity: 0.55;
  }

  .bar {
    font-size: 0.85rem;
    font-variant-numeric: tabular-nums;
  }

  /* Past ten seconds. Not an error — the opposite: it is the line saying it is
     still working, which is the moment you start to wonder. */
  .bar.slow {
    color: #d9a15b;
    opacity: 0.85;
  }

  @media (min-width: 768px) {
    .shell {
      flex-direction: row;
      align-items: flex-start;
    }

    .content {
      flex: 1;
      padding: 3vh 1.5rem 0;
    }

    .abbe {
      font-size: 1.05rem;
    }

    .term {
      --label: 5.5rem;
      --gap: 1.5rem;
    }

    h1 {
      margin-top: 4rem;
      font-size: 3rem;
    }
  }
</style>
