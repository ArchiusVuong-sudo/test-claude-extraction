import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { Command } from "commander";

// Color codes for terminal
const Colors = {
  CYAN: "\x1b[96m",
  GREEN: "\x1b[92m",
  YELLOW: "\x1b[93m",
  RED: "\x1b[91m",
  ENDC: "\x1b[0m",
  DIM: "\x1b[2m",
};

interface Message {
  type: "user" | "assistant";
  text: string;
  timestamp: string;
  id: string;
}

function getProjectsDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return path.join(home, ".claude", "projects");
}

function findConversationFiles(
  projectsDir: string,
  projectFilter?: string
): Map<string, string[]> {
  const convFiles = new Map<string, string[]>();

  function walkDir(dir: string): void {
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
          walkDir(fullPath);
        } else if (file.endsWith(".jsonl")) {
          const parent = path.basename(dir);

          // Apply project filter if specified
          if (projectFilter && !parent.toLowerCase().includes(projectFilter.toLowerCase())) {
            continue;
          }

          if (!convFiles.has(parent)) {
            convFiles.set(parent, []);
          }
          convFiles.get(parent)!.push(fullPath);
        }
      }
    } catch (e) {
      // Ignore read errors
    }
  }

  walkDir(projectsDir);
  return convFiles;
}

async function extractAllMessages(
  filePath: string,
  lastPos?: number
): Promise<Message[]> {
  const messages: Message[] = [];

  try {
    const fileStream = fs.createReadStream(filePath, {
      start: lastPos,
    });

    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      try {
        const data = JSON.parse(line);

        // Skip agent initialization files
        if (data.agentId) {
          continue;
        }

        if (data.type === "user" && data.message) {
          const content = data.message.content || [];
          for (const item of content) {
            if (item.type === "text") {
              const text = item.text?.trim() || "";
              // Skip metadata tags
              if (
                text &&
                !text.startsWith("<") &&
                !text.startsWith("This may or may not")
              ) {
                messages.push({
                  type: "user",
                  text,
                  timestamp: data.timestamp || "",
                  id: data.uuid || "",
                });
              }
            }
          }
        } else if (data.type === "assistant" && data.message) {
          const content = data.message.content || [];
          for (const item of content) {
            if (item.type === "text") {
              const text = item.text?.trim() || "";
              if (text) {
                messages.push({
                  type: "assistant",
                  text,
                  timestamp: data.timestamp || "",
                  id: data.uuid || "",
                });
              }
            }
          }
        }
      } catch (e) {
        // Skip invalid JSON lines
      }
    }
  } catch (e) {
    // Ignore read errors
  }

  return messages;
}

function formatResponse(text: string, maxWidth?: number): string[] {
  if (!maxWidth) {
    try {
      maxWidth = process.stdout.columns ? process.stdout.columns - 4 : 100;
    } catch {
      maxWidth = 100;
    }
  }

  const lines = text.split("\n");
  const formatted: string[] = [];

  for (const line of lines) {
    let currentLine = line;
    while (currentLine.length > maxWidth) {
      formatted.push(currentLine.substring(0, maxWidth));
      currentLine = currentLine.substring(maxWidth);
    }
    formatted.push(currentLine);
  }

  return formatted;
}

async function watchConversations(
  projectFilter?: string,
  compact: boolean = false
): Promise<void> {
  const projectsDir = getProjectsDir();

  if (!fs.existsSync(projectsDir)) {
    console.log(
      `${Colors.RED}Error: Claude Code directory not found at ${projectsDir}${Colors.ENDC}`
    );
    process.exit(1);
  }

  const seenResponses = new Map<string, Set<string>>();
  const filePositions = new Map<string, number>();
  let initialLoad = true;

  try {
    while (true) {
      const convFiles = findConversationFiles(projectsDir, projectFilter);

      if (initialLoad && convFiles.size === 0) {
        console.log(
          `${Colors.YELLOW}No conversations found. Waiting...${Colors.ENDC}`
        );
        initialLoad = false;
      }

      // Sort projects for consistent output
      const projects = Array.from(convFiles.keys()).sort();

      for (const project of projects) {
        const files = convFiles.get(project) || [];

        for (const filePath of files) {
          // On first run, skip all existing content and start from end
          if (!filePositions.has(filePath)) {
            try {
              const stat = fs.statSync(filePath);
              filePositions.set(filePath, stat.size);
            } catch {
              // Ignore
            }
            continue;
          }

          const lastPos = filePositions.get(filePath);

          // Extract all messages
          const messages = await extractAllMessages(filePath, lastPos);

          // Update file position
          try {
            const stat = fs.statSync(filePath);
            filePositions.set(filePath, stat.size);
          } catch {
            // Ignore
          }

          // Track and display new messages
          if (!seenResponses.has(filePath)) {
            seenResponses.set(filePath, new Set());
          }

          const seen = seenResponses.get(filePath)!;

          for (const message of messages) {
            if (!seen.has(message.id)) {
              seen.add(message.id);
              initialLoad = false;

              const timestamp = new Date().toLocaleTimeString("en-US", {
                hour12: false,
              });
              const isUser = message.type === "user";
              const marker = isUser ? ">>" : "<<";
              const markerColor = isUser ? Colors.YELLOW : Colors.GREEN;

              if (compact) {
                const lines = formatResponse(message.text);
                process.stdout.write(`${Colors.DIM}[${timestamp}]${Colors.ENDC} `);
                for (let i = 0; i < lines.length; i++) {
                  if (i > 0) {
                    process.stdout.write("         ");
                  }
                  console.log(lines[i]);
                }
              } else {
                console.log(
                  `${Colors.DIM}[${timestamp}] ${Colors.CYAN}${project}${Colors.ENDC}`
                );

                const lines = formatResponse(message.text);
                console.log(
                  `${markerColor}${marker}${Colors.ENDC} ${lines[0]}`
                );
                for (let i = 1; i < lines.length; i++) {
                  console.log(`   ${lines[i]}`);
                }
                console.log();
              }
            }
          }
        }
      }

      // Poll for changes every 100ms
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (e) {
    if (e instanceof Error && e.message !== "Interrupt") {
      console.log(`${Colors.RED}Error: ${e.message}${Colors.ENDC}`);
      process.exit(1);
    }
  }
}

// Handle Ctrl+C gracefully
process.on("SIGINT", () => {
  console.log(`\n${Colors.GREEN}Stopped tracking${Colors.ENDC}`);
  process.exit(0);
});

const program = new Command();

program
  .description("Track Claude Code conversation deltas in real-time")
  .argument("[project]", "Project name to filter (optional)")
  .option("-c, --compact", "Compact output format")
  .action((project: string | undefined, options: { compact?: boolean }) => {
    watchConversations(project, options.compact || false).catch((e) => {
      console.error(`${Colors.RED}Error: ${e.message}${Colors.ENDC}`);
      process.exit(1);
    });
  });

program.parse(process.argv);
