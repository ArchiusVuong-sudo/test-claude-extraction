#!/usr/bin/env python3
"""
Real-time CLI tracker for Claude Code conversation deltas.
Shows only assistant responses as they are generated.

Usage:
    python3 track_claude_delta.py                    # Track all projects
    python3 track_claude_delta.py <project_name>    # Track specific project
    python3 track_claude_delta.py --help             # Show help
"""

import json
import os
import sys
from pathlib import Path
from datetime import datetime
import time
from collections import defaultdict
import argparse

# Color codes for terminal
class Colors:
    CYAN = '\033[96m'
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    RED = '\033[91m'
    ENDC = '\033[0m'
    DIM = '\033[2m'


def get_projects_dir():
    """Get the Claude Code projects directory."""
    home = Path.home()
    return home / '.claude' / 'projects'


def find_conversation_files(projects_dir, project_filter=None):
    """Find all conversation JSONL files, optionally filtered by project."""
    conv_files = {}
    for file_path in projects_dir.rglob('*.jsonl'):
        parent = file_path.parent.name

        # Apply project filter if specified
        if project_filter and project_filter.lower() not in parent.lower():
            continue

        if parent not in conv_files:
            conv_files[parent] = []
        conv_files[parent].append(file_path)
    return conv_files


def extract_all_messages(file_path, last_pos=None):
    """Extract all user and assistant messages from a conversation file after last_pos."""
    messages = []
    try:
        with open(file_path, 'r') as f:
            if last_pos is not None:
                f.seek(last_pos)
            for line in f:
                try:
                    data = json.loads(line)
                    # Skip agent initialization files (they have agentId)
                    if data.get('agentId'):
                        continue

                    if data.get('type') == 'user' and data.get('message'):
                        content = data['message'].get('content', [])
                        for item in content:
                            if item.get('type') == 'text':
                                text = item.get('text', '').strip()
                                # Skip metadata tags (ide_selection, ide_opened_file, etc.)
                                if text and not text.startswith('<') and not text.startswith('This may or may not'):
                                    messages.append({
                                        'type': 'user',
                                        'text': text,
                                        'timestamp': data.get('timestamp'),
                                        'id': data.get('uuid')
                                    })

                    elif data.get('type') == 'assistant' and data.get('message'):
                        content = data['message'].get('content', [])
                        for item in content:
                            if item.get('type') == 'text':
                                text = item.get('text', '').strip()
                                if text:
                                    messages.append({
                                        'type': 'assistant',
                                        'text': text,
                                        'timestamp': data.get('timestamp'),
                                        'id': data.get('uuid')
                                    })
                except json.JSONDecodeError:
                    continue
    except (IOError, PermissionError):
        pass
    return messages


def format_response(text, max_width=None):
    """Format response text for terminal display."""
    if max_width is None:
        # Get terminal width, default to 100
        try:
            max_width = os.get_terminal_size().columns - 4
        except:
            max_width = 100

    lines = text.split('\n')
    formatted = []
    for line in lines:
        # Wrap long lines
        while len(line) > max_width:
            formatted.append(line[:max_width])
            line = line[max_width:]
        formatted.append(line)
    return formatted




def watch_conversations(project_filter=None, compact=False):
    """Watch conversation files and track deltas in real-time."""
    projects_dir = get_projects_dir()

    if not projects_dir.exists():
        print(f"{Colors.RED}Error: Claude Code directory not found at {projects_dir}{Colors.ENDC}")
        sys.exit(1)

    # Track which responses we've already seen and file positions
    seen_responses = defaultdict(set)
    file_positions = {}


    try:
        initial_load = True
        while True:
            conv_files = find_conversation_files(projects_dir, project_filter)

            if initial_load and not conv_files:
                print(f"{Colors.YELLOW}No conversations found. Waiting...{Colors.ENDC}")
                initial_load = False

            for project, files in sorted(conv_files.items()):
                for file_path in files:
                    file_key = str(file_path)

                    # On first run, skip all existing content and start from end of file
                    if file_key not in file_positions:
                        try:
                            with open(file_path, 'r') as f:
                                f.seek(0, 2)  # Seek to end
                                file_positions[file_key] = f.tell()
                        except:
                            pass
                        continue  # Skip processing this file on first load

                    last_pos = file_positions.get(file_key, None)

                    # Extract all messages (user and assistant)
                    messages = extract_all_messages(file_path, last_pos)

                    # Update file position
                    try:
                        with open(file_path, 'r') as f:
                            f.seek(0, 2)  # Seek to end
                            file_positions[file_key] = f.tell()
                    except:
                        pass

                    for message in messages:
                        msg_id = message['id']

                        # Check if we haven't seen this message before
                        if msg_id not in seen_responses[file_key]:
                            seen_responses[file_key].add(msg_id)
                            initial_load = False

                            # Display the delta
                            timestamp = datetime.now().strftime("%H:%M:%S")
                            is_user = message['type'] == 'user'

                            if compact:
                                # Compact format: just the message
                                lines = format_response(message['text'])
                                marker = ">>" if is_user else "<<"
                                marker_color = Colors.YELLOW if is_user else Colors.GREEN
                                print(f"{Colors.DIM}[{timestamp}]{Colors.ENDC} ", end='', flush=True)
                                for i, line in enumerate(lines):
                                    if i > 0:
                                        print('         ', end='', flush=True)
                                    print(line, flush=True)
                                print()
                            else:
                                # Full format with header
                                print(f"{Colors.DIM}[{timestamp}] {Colors.CYAN}{project}{Colors.ENDC}", flush=True)

                                # Format and print the message
                                message_text = message['text']
                                lines = format_response(message_text)
                                marker = ">>" if is_user else "<<"
                                marker_color = Colors.YELLOW if is_user else Colors.GREEN
                                print(f"{marker_color}{marker}{Colors.ENDC} {lines[0]}", flush=True)
                                for line in lines[1:]:
                                    print(f"   {line}", flush=True)
                                print()

            # Poll for changes every 0.1 seconds (faster real-time detection)
            time.sleep(0.1)

    except KeyboardInterrupt:
        print(f"\n{Colors.GREEN}Stopped tracking{Colors.ENDC}")
        sys.exit(0)
    except Exception as e:
        print(f"{Colors.RED}Error: {e}{Colors.ENDC}")
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(
        description='Track Claude Code conversation deltas in real-time',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
Examples:
  # Track all projects
  python3 track_claude_delta.py

  # Track specific project
  python3 track_claude_delta.py temp

  # Compact output format
  python3 track_claude_delta.py --compact
        '''
    )

    parser.add_argument('project', nargs='?', help='Project name to filter (optional)')
    parser.add_argument('-c', '--compact', action='store_true', help='Compact output format')

    args = parser.parse_args()

    watch_conversations(
        project_filter=args.project,
        compact=args.compact
    )


if __name__ == '__main__':
    main()
