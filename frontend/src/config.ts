import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const configPath = resolve(process.cwd(), '../config/config.yaml')
const raw = readFileSync(configPath, 'utf-8')

const match = raw.match(/clicky_mode\s*[:=]\s*(true|false)/i)

export const clickyMode = match ? match[1].toLowerCase() === 'true' : false
