const groups = [
  {
    title: 'Find and explore',
    shortcuts: [
      [
        'Find sessions and workspace files',
        'Ctrl+P',
        'Jump to another conversation or open a workspace file.',
      ],
      [
        'Browse commands and actions',
        'Ctrl+Shift+P',
        'Switch agents, change themes, manage connections, and discover other actions.',
      ],
      ['Show keyboard shortcuts', 'Ctrl+/', 'Open this shortcut reference.'],
      ['Open Settings', 'Ctrl+,', 'Configure Gateway profiles, appearance, and notifications.'],
    ],
  },
  {
    title: 'Chat and sessions',
    shortcuts: [
      ['Previous session', 'Ctrl+PageUp', 'Move through the sessions in the sidebar.'],
      ['Next session', 'Ctrl+PageDown', 'Wraps to the first session after the last one.'],
      ['Send a message', 'Enter', 'Send the message when the agent is ready.'],
      ['Insert a new line', 'Shift+Enter', 'Continue writing without sending.'],
      [
        'Browse slash commands and templates',
        '/',
        'Type at the start of a message to browse commands and reusable prompts.',
      ],
      [
        'Paste an attachment',
        'Ctrl+V',
        'Paste supported images or files into the message composer.',
      ],
    ],
  },
  {
    title: 'Workspace and windows',
    shortcuts: [
      [
        'Save the workspace file',
        'Ctrl+S',
        'Save edits to the Gateway while the workspace editor is open.',
      ],
      [
        'Close a popup or dialog',
        'Esc',
        'Dismiss the current menu, search popup, or Settings window.',
      ],
      [
        'Quit YAOC',
        'Ctrl+Q',
        'Open the quit confirmation. Press again to confirm; closing the window normally hides YAOC to the tray.',
      ],
    ],
  },
];

export default function KeyboardShortcuts({ globalHotkey }: { globalHotkey: string }) {
  return (
    <>
      <div className="shortcuts-intro">
        <h4>Keyboard shortcuts</h4>
        <p className="settings-help">
          Explore what YAOC can do, then use these keys to get there faster.
        </p>
      </div>
      {groups.map((group) => (
        <section className="shortcuts-group" key={group.title} aria-label={group.title}>
          <h5>{group.title}</h5>
          <dl className="shortcuts-list">
            {group.shortcuts.map(([action, keys, description]) => (
              <div className="shortcut-row" key={action}>
                <dt>
                  {action}
                  <span className="shortcut-description">{description}</span>
                </dt>
                <dd>
                  <kbd>{keys}</kbd>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      <section className="shortcuts-group" aria-label="Global shortcut">
        <h5>Global shortcut</h5>
        <dl className="shortcuts-list">
          <div className="shortcut-row">
            <dt>
              Show or hide YAOC
              <span className="shortcut-description">
                Works while another app is focused. Change it in General settings.
              </span>
            </dt>
            <dd>
              {globalHotkey ? (
                <kbd>{globalHotkey}</kbd>
              ) : (
                <span className="shortcut-description">Disabled</span>
              )}
            </dd>
          </div>
        </dl>
      </section>
      <p className="settings-help">
        In search and command menus, use ↑ / ↓ to choose an item, Enter to open it, and Esc to
        close. Type &gt; in search to browse commands. App shortcuts pause while recording a global
        shortcut or when a conflicting dialog is open.
      </p>
    </>
  );
}
