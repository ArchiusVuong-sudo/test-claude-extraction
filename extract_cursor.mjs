#!/usr/bin/env node

/**
 * Cursor IDE Message Extractor
 *
 * Extracts real-time chat messages from Cursor IDE's local database.
 * Uses better-sqlite3 to read from Cursor's state.vscdb and globalStorage/state.vscdb
 */

import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const Colors = {
  CYAN: '\x1b[96m',
  GREEN: '\x1b[92m',
  YELLOW: '\x1b[93m',
  RED: '\x1b[91m',
  ENDC: '\x1b[0m',
  DIM: '\x1b[2m',
}

function getCursorGlobalStorageDb() {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  return path.join(home, 'Library/Application Support/Cursor/User/globalStorage/state.vscdb')
}

function getCursorWorkspaces() {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const workspaceStoragePath = path.join(
    home,
    'Library/Application Support/Cursor/User/workspaceStorage'
  )

  if (!fs.existsSync(workspaceStoragePath)) {
    return []
  }

  return fs
    .readdirSync(workspaceStoragePath)
    .filter(dir => {
      const dirPath = path.join(workspaceStoragePath, dir)
      return fs.statSync(dirPath).isDirectory()
    })
    .map(dir => path.join(workspaceStoragePath, dir))
}

function extractBubbles(db, composerId) {
  const bubbles = []

  try {
    const query = `
      SELECT key, value FROM cursorDiskKV
      WHERE key LIKE 'bubbleId:%:${composerId}:%'
    `
    const rows = db.prepare(query).all()

    for (const row of rows) {
      try {
        const bubble = JSON.parse(row.value)
        if (bubble && bubble.text) {
          bubbles.push({
            id: row.key,
            text: bubble.text,
            timestamp: bubble.timestamp || Date.now(),
            type: bubble.type || 'unknown',
          })
        }
      } catch (e) {
        // Skip parse errors
      }
    }
  } catch (e) {
    // Query may fail if table doesn't exist
  }

  return bubbles
}

function loadConversations(db) {
  const conversations = []

  try {
    const query = `
      SELECT key, value FROM cursorDiskKV
      WHERE key LIKE 'composerData:%'
      AND value LIKE '%fullConversationHeadersOnly%'
    `
    const rows = db.prepare(query).all()

    for (const row of rows) {
      try {
        const composerData = JSON.parse(row.value)
        const composerId = row.key.split(':')[1]
        const headers = composerData.fullConversationHeadersOnly || []

        if (headers.length > 0) {
          conversations.push({
            id: composerId,
            name: composerData.name || `Conversation ${composerId.slice(0, 8)}`,
            headers,
            lastUpdated: composerData.lastUpdatedAt || composerData.createdAt,
          })
        }
      } catch (e) {
        // Skip parse errors
      }
    }
  } catch (e) {
    // Query may fail if table doesn't exist
  }

  return conversations
}

async function watchCursorConversations(projectFilter = null, compact = false) {
  const dbPath = getCursorGlobalStorageDb()

  if (!fs.existsSync(dbPath)) {
    console.log(
      `${Colors.RED}Error: Cursor database not found at ${dbPath}${Colors.ENDC}`
    )
    console.log(
      `${Colors.DIM}Make sure Cursor IDE is installed and has been opened at least once${Colors.ENDC}`
    )
    process.exit(1)
  }

  const seenBubbles = new Set()
  let lastCheck = 0

  console.log(
    `${Colors.CYAN}Cursor IDE Message Tracker${Colors.ENDC}`
  )
  console.log(
    `${Colors.DIM}Database: ${dbPath}${Colors.ENDC}\n`
  )

  try {
    while (true) {
      try {
        const db = new Database(dbPath, { readonly: true })

        const conversations = loadConversations(db)

        if (conversations.length === 0 && lastCheck === 0) {
          console.log(
            `${Colors.YELLOW}No conversations found. Waiting for Cursor activity...${Colors.ENDC}`
          )
        }

        lastCheck = conversations.length

        for (const conversation of conversations) {
          if (projectFilter && !conversation.name.toLowerCase().includes(projectFilter.toLowerCase())) {
            continue
          }

          for (const header of conversation.headers) {
            const bubbleId = header.bubbleId
            const headerType = header.type // 1 = user, other = assistant

            if (!seenBubbles.has(bubbleId)) {
              seenBubbles.add(bubbleId)

              // Extract bubble text from database
              try {
                const bubbleQuery = `
                  SELECT value FROM cursorDiskKV
                  WHERE key = 'bubbleId:${bubbleId}'
                `
                const bubbleRow = db.prepare(bubbleQuery).get()

                if (bubbleRow) {
                  const bubble = JSON.parse(bubbleRow.value)
                  const text = bubble.text || ''

                  if (text.trim()) {
                    const timestamp = new Date().toLocaleTimeString('en-US', {
                      hour12: false,
                    })
                    const isUser = headerType === 1
                    const marker = isUser ? '>>' : '<<'
                    const markerColor = isUser ? Colors.YELLOW : Colors.GREEN

                    if (compact) {
                      const line = text.split('\n')[0]
                      console.log(
                        `${Colors.DIM}[${timestamp}]${Colors.ENDC} ${marker} ${line.substring(0, 100)}`
                      )
                    } else {
                      console.log(
                        `${Colors.DIM}[${timestamp}] ${Colors.CYAN}${conversation.name}${Colors.ENDC}`
                      )
                      console.log(`${markerColor}${marker}${Colors.ENDC} ${text}`)
                      console.log()
                    }
                  }
                }
              } catch (e) {
                // Skip if bubble not found
              }
            }
          }
        }

        db.close()
      } catch (e) {
        // Retry on database lock or other errors
      }

      // Poll every 500ms
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  } catch (e) {
    if (e instanceof Error && e.message !== 'Interrupt') {
      console.log(`${Colors.RED}Error: ${e.message}${Colors.ENDC}`)
      process.exit(1)
    }
  }
}

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  console.log(`\n${Colors.GREEN}Stopped tracking${Colors.ENDC}`)
  process.exit(0)
})

// Parse arguments
const args = process.argv.slice(2)
let projectFilter = null
let compact = false

for (let i = 0; i < args.length; i++) {
  if (args[i] === '-c' || args[i] === '--compact') {
    compact = true
  } else if (args[i] === '-h' || args[i] === '--help') {
    console.log(`Usage: extract_cursor [options] [project]

Track Cursor IDE chat messages in real-time

Options:
  -c, --compact  Compact output format
  -h, --help     Display help for command`)
    process.exit(0)
  } else if (!args[i].startsWith('-')) {
    projectFilter = args[i]
  }
}

watchCursorConversations(projectFilter, compact).catch(e => {
  console.error(`${Colors.RED}Error: ${e.message}${Colors.ENDC}`)
  process.exit(1)
})
