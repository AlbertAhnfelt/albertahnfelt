<script lang="ts">
  /**
   * Everything said so far: turns, the tool calls behind them, and the
   * terminal's own output.
   *
   * A list rendered by Svelte rather than elements appended as things happen.
   * That is the point of the migration: these rows are in a template, so the
   * scoped styles below actually reach them. Built by hand they never did —
   * Astro stamps its scope attribute on template elements only, so every rule
   * written for a createElement'd row matched nothing, silently.
   */

  import type { Row } from '../../lib/abbe/types'

  type Props = { rows: Row[]; verbose: boolean }

  let { rows, verbose }: Props = $props()

  const clock = (at: number) =>
    new Date(at).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit' })
</script>

<div class="log" class:verbose>
  {#each rows as row (row.id)}
    {#if row.kind === 'said'}
      <div class="line {row.role}" class:partial={row.partial} class:streaming={row.streaming}>
        <span class="who">
          {row.role === 'me' ? 'Albert' : 'Abbe'}
          <span class="at">{clock(row.at)}</span>
        </span>
        <span class="body">{row.text}</span>
      </div>
    {:else if row.kind === 'tool'}
      <div class="trace" class:failed={!row.tool.ok}>
        <span class="tname">{row.tool.name}</span>
        <span class="tdetail">{row.tool.detail}</span>
        <span class="tms">{row.tool.ms === null ? '' : `${row.tool.ms} ms`}</span>
      </div>
    {:else}
      <div class="sys">
        <div class="sysh">{row.heading}</div>
        {#each row.rows as entry, i (i)}
          <span class="sysk">{entry.key}</span>
          <span class="sysv">
            {#if entry.href}
              <a href={entry.href}>{entry.value}</a>
            {:else}
              {entry.value}
            {/if}
          </span>
        {/each}
      </div>
    {/if}
  {/each}
</div>

<style>
  .line {
    display: grid;
    grid-template-columns: var(--label) 1fr;
    gap: 0 var(--gap);
    align-items: start;
    margin-bottom: 1.15rem;
  }

  /* Only the name is coloured — the message itself stays white. */
  .line.me .who {
    color: var(--me);
  }

  .line.abbe .who {
    color: var(--abbe);
  }

  /* Joan ships Regular only, so the browser synthesises this weight. */
  .who {
    font-weight: 700;
  }

  /* The time, under the name. In the label column it costs no width from the
     message, which is what matters on a phone. */
  .at {
    display: block;
    font-size: 0.65rem;
    font-weight: 400;
    letter-spacing: 0.04em;
    font-variant-numeric: tabular-nums;
    opacity: 0.3;
  }

  .body {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  /* A reply whose stream died before the model finished. Stored and shown
     rather than dropped, but marked, so it does not read as a whole thought. */
  .line.partial .body::after {
    content: ' …';
    opacity: 0.4;
  }

  /* A reply as it arrives: a block riding the last character. This is also what
     stands in for "thinking" before the first token lands — an empty line with
     a blinking cursor, which is what a terminal does and needs no words. */
  .line.streaming .body::after {
    content: '';
    display: inline-block;
    width: 0.5em;
    height: 1em;
    margin-left: 0.1em;
    background: var(--abbe);
    vertical-align: -0.15em;
    animation: blink 1s steps(1, end) infinite;
  }

  @keyframes blink {
    50% {
      opacity: 0;
    }
  }

  /* ------------------------------------------------------- the tool trace */

  /* Every call is rendered; only .verbose shows them. That way turning it on
     reveals the calls behind replies already on screen instead of only
     applying to the next question. */
  .trace {
    display: none;
  }

  .verbose .trace {
    display: grid;
    grid-template-columns: var(--label) auto 1fr;
    gap: 0 0.6rem;
    margin-bottom: 0.3rem;
    font-size: 0.8rem;
    opacity: 0.4;
  }

  /* The name sits in the label column, where a speaker's name would — these are
     the closest thing the vault has to a speaking part. */
  .tname {
    text-align: right;
  }

  .tdetail {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tms {
    text-align: right;
    font-variant-numeric: tabular-nums;
    opacity: 0.7;
  }

  .trace.failed {
    color: var(--me);
  }

  /* ---------------------------------------- the terminal's own output */

  /* Help, search results, notices. A grid rather than padded text: the site's
     face is proportional, so columns cannot be faked with spaces. */
  .sys {
    display: grid;
    grid-template-columns: var(--label) 1fr;
    gap: 0.15rem var(--gap);
    margin: 0 0 1.3rem;
    font-size: 0.9rem;
  }

  .sysh {
    grid-column: 1 / -1;
    margin-bottom: 0.35rem;
    font-size: 0.7rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    opacity: 0.35;
  }

  .sysk {
    text-align: right;
    opacity: 0.5;
  }

  .sysv {
    opacity: 0.8;
  }

  .sysv a {
    text-decoration: underline;
  }

  @media (prefers-reduced-motion: reduce) {
    .line.streaming .body::after {
      animation: none;
    }
  }
</style>
