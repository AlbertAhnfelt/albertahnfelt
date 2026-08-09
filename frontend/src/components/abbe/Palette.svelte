<script lang="ts">
  /**
   * The command list, above the prompt.
   *
   * Opens on a leading "/" and narrows as you type. It sits above rather than
   * below because the prompt is the last thing on the page — a list under it
   * would push the thing you are typing into off the bottom on a phone, which
   * is the one place this has to behave.
   */

  import type { Command } from '../../lib/abbe/commands'

  type Props = {
    items: Command[]
    selected: number
    onpick: (command: Command) => void
  }

  let { items, selected, onpick }: Props = $props()
</script>

{#if items.length > 0}
  <!-- Not a listbox: the textarea keeps focus throughout, and the selection is
       announced through aria-activedescendant on it rather than by moving
       focus into this list. -->
  <div class="palette" id="abbe-palette" role="listbox" aria-label="Kommandon">
    {#each items as command, i (command.name)}
      <button
        type="button"
        class="row"
        class:on={i === selected}
        id="abbe-cmd-{command.action}"
        role="option"
        aria-selected={i === selected}
        onclick={() => onpick(command)}
      >
        <!-- The gap is a margin, not a literal space: the compiler trims
             whitespace at the edge of an element and `/vault<fras>` is not a
             thing anybody typed. -->
        <span class="name"
          >{command.name}{#if command.arg}<span class="arg">{command.arg}</span>{/if}</span
        >
        <span class="help">{command.help}</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .palette {
    display: grid;
    /* Lines up with the message column, so the list hangs off the prompt rather
       than floating loose in the margin. */
    margin: 0 0 0.6rem;
    padding-left: calc(var(--label) + var(--gap));
  }

  .row {
    display: grid;
    grid-template-columns: minmax(6rem, auto) 1fr;
    gap: 0 1rem;
    align-items: baseline;
    width: 100%;
    font: inherit;
    color: inherit;
    text-align: left;
    background: none;
    border: 0;
    border-left: 2px solid transparent;
    padding: 0.2rem 0.5rem;
    cursor: pointer;
    opacity: 0.45;
  }

  .row:hover {
    opacity: 0.75;
  }

  /* The one Enter will run. A bar and a lift rather than a fill: the terminal
     has no boxes anywhere else and one here would read as a different app. */
  .row.on {
    opacity: 1;
    border-left-color: var(--me);
    background: rgba(239, 237, 234, 0.04);
  }

  .name {
    font-size: 0.95rem;
  }

  .arg {
    margin-left: 0.4em;
    opacity: 0.4;
  }

  .help {
    font-size: 0.85rem;
    opacity: 0.6;
  }

  @media (max-width: 767px) {
    /* The label column is dead weight here on a narrow screen. */
    .palette {
      padding-left: 0;
    }

    .row {
      grid-template-columns: 1fr;
      gap: 0;
    }
  }
</style>
