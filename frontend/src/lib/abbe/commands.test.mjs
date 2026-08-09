/**
 * The command logic, tested directly.
 *
 * This is the part of the migration that pays for itself twice: the matching
 * and completion rules used to be closures inside an 880-line page script,
 * reachable only by driving a browser. As plain functions they are checkable in
 * milliseconds, which is why the awkward cases below are covered at all.
 *
 *   node --test src/lib/abbe/commands.test.mjs
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  COMMANDS,
  completionFor,
  findCommand,
  isCommand,
  matchCommands,
  splitCommand,
} from './commands.ts'

test('every command has a unique name and no alias collides', () => {
  const seen = new Set()
  for (const command of COMMANDS) {
    for (const name of [command.name, ...(command.aliases ?? [])]) {
      assert.ok(name.startsWith('/'), `${name} should start with a slash`)
      assert.ok(!seen.has(name), `${name} is claimed twice`)
      seen.add(name)
    }
  }
})

test('command names are English', () => {
  // The mixed set this replaced — /ny, /rensa, /valv, /verbose, /hjälp — is
  // what looked wrong. The Swedish ones survive only as aliases.
  assert.deepEqual(
    COMMANDS.map((c) => c.name),
    ['/new', '/clear', '/vault', '/verbose', '/help'],
  )
})

test('isCommand only claims lines that start with a slash', () => {
  assert.equal(isCommand('/help'), true)
  assert.equal(isCommand('vad ligger i valvet?'), false)
  assert.equal(isCommand('en fråga om /vault'), false)
  assert.equal(isCommand(''), false)
})

test('splitCommand separates the head from the argument', () => {
  assert.deepEqual(splitCommand('/vault loggning'), { head: '/vault', rest: 'loggning' })
  assert.deepEqual(splitCommand('/help'), { head: '/help', rest: '' })
  // The rest is kept verbatim, spaces and all — it is a search phrase.
  assert.deepEqual(splitCommand('/vault  två  ord '), { head: '/vault', rest: ' två  ord ' })
  assert.deepEqual(splitCommand('/HELP'), { head: '/help', rest: '' })
})

test('findCommand resolves canonical names and aliases', () => {
  assert.equal(findCommand('/new')?.action, 'new')
  assert.equal(findCommand('/ny')?.action, 'new')
  assert.equal(findCommand('/hjälp')?.action, 'help')
  assert.equal(findCommand('/?')?.action, 'help')
  assert.equal(findCommand('/nope'), null)
})

test('the palette opens on a bare slash with everything', () => {
  assert.equal(matchCommands('/').length, COMMANDS.length)
})

test('the palette narrows as you type', () => {
  assert.deepEqual(
    matchCommands('/v').map((c) => c.name),
    ['/vault', '/verbose'],
  )
  assert.deepEqual(
    matchCommands('/ve').map((c) => c.name),
    ['/verbose'],
  )
  assert.deepEqual(matchCommands('/zzz'), [])
})

test('the palette finds a command by its Swedish alias but offers the real name', () => {
  assert.deepEqual(
    matchCommands('/ny').map((c) => c.name),
    ['/new'],
  )
})

test('the palette closes once an argument is being typed', () => {
  // Otherwise the list sits over the phrase you are trying to read.
  assert.deepEqual(matchCommands('/vault '), [])
  assert.deepEqual(matchCommands('/vault loggning'), [])
})

test('the palette stays shut for ordinary messages', () => {
  assert.deepEqual(matchCommands('vad ligger i valvet?'), [])
  assert.deepEqual(matchCommands(''), [])
})

test('the ghost completes a unique prefix', () => {
  assert.equal(completionFor('/ve', true), 'rbose')
  assert.equal(completionFor('/c', true), 'lear')
})

test('the ghost refuses to guess between two commands', () => {
  // /v is both /vault and /verbose. A ghost that picks one is worse than none.
  assert.equal(completionFor('/v', true), '')
})

test('the ghost becomes the argument hint once the name is complete', () => {
  assert.equal(completionFor('/vault', true), ' <fras>')
  // A command that takes no argument has nothing left to suggest.
  assert.equal(completionFor('/help', true), '')
})

test('the ghost goes quiet away from the end of the line', () => {
  // A suggestion trailing text being edited in the middle is noise.
  assert.equal(completionFor('/ve', false), '')
})

test('the ghost goes quiet once there is an argument', () => {
  assert.equal(completionFor('/vault log', true), '')
})

test('the ghost never completes an alias into itself', () => {
  // Typing /n uniquely identifies /new via the alias /ny, but what gets
  // completed is the canonical name — you should end up learning that one.
  const suggestion = completionFor('/n', true)
  assert.ok(suggestion === '' || '/n' + suggestion === '/new', `got ${JSON.stringify(suggestion)}`)
})

test('an ordinary message never grows a ghost', () => {
  assert.equal(completionFor('vad ligger i valvet?', true), '')
})
