const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const vm = require('node:vm');

const compile = (source) =>
  ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
    },
  }).outputText;

function createComponentHarness() {
  let slots = [];
  let cursor = 0;
  const effects = [];
  const layoutEffects = [];

  const hooks = {
    useState(initial) {
      const id = cursor++;
      if (!(id in slots)) slots[id] = typeof initial === 'function' ? initial() : initial;
      return [
        slots[id],
        (update) => {
          slots[id] = typeof update === 'function' ? update(slots[id]) : update;
        },
      ];
    },
    useRef(initial) {
      const id = cursor++;
      return (slots[id] ??= { current: initial });
    },
    useEffect(fn) {
      effects.push(fn);
    },
    useLayoutEffect(fn) {
      layoutEffects.push(fn);
    },
  };

  const reactMock = {
    ...hooks,
    default: {
      ...hooks,
      createElement(type, props, ...children) {
        return { type, props: { ...props, children } };
      },
    },
    createElement(type, props, ...children) {
      return { type, props: { ...props, children } };
    },
  };

  const reactDomMock = {
    createPortal(children, container) {
      return { type: 'portal', props: { children, container } };
    },
  };

  const lucideMock = {
    Check: (props) => ({ type: 'Check', props }),
    ChevronDown: (props) => ({ type: 'ChevronDown', props }),
  };

  const exportsObject = {};
  const agentSwitcherSource = fs.readFileSync('src/AgentSwitcher.tsx', 'utf8');

  vm.runInNewContext(compile(agentSwitcherSource), {
    exports: exportsObject,
    require(name) {
      if (name === 'react') return reactMock;
      if (name === 'react-dom') return reactDomMock;
      if (name === 'lucide-react') return lucideMock;
      return {};
    },
    document: {
      body: {},
      addEventListener() {},
      removeEventListener() {},
    },
    window: {
      innerWidth: 1024,
      innerHeight: 768,
      addEventListener() {},
      removeEventListener() {},
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
  });

  const AgentSwitcher = exportsObject.default || exportsObject;

  function render(props) {
    cursor = 0;
    return AgentSwitcher(props);
  }

  function reset() {
    slots = [];
    cursor = 0;
  }

  return { render, reset, getSlot: (idx) => slots[idx], setSlot: (idx, val) => (slots[idx] = val) };
}

test('AgentSwitcher displays formatted labels correctly', () => {
  const harness = createComponentHarness();

  // Test 1: name matches id -> only display id
  let tree = harness.render({
    agents: [{ id: 'main', name: 'main' }],
    selectedAgentId: 'main',
    onSelectAgent() {},
  });
  assert.equal(tree.type, 'div');
  assert.equal(tree.props.className, 'agent-switcher-container');
  const button = tree.props.children[0];
  assert.equal(button.type, 'button');
  assert.equal(button.props.className, 'agent-selector');
  assert.equal(button.props.title, 'Active Agent: main');
  assert.equal(button.props.disabled, false);

  // Test 2: name is distinct from id -> display Name (id)
  harness.reset();
  tree = harness.render({
    agents: [{ id: 'agent-codex', name: 'Codex Expert' }],
    selectedAgentId: 'agent-codex',
    onSelectAgent() {},
  });
  const button2 = tree.props.children[0];
  assert.equal(button2.props.title, 'Active Agent: Codex Expert (agent-codex)');

  // Test 3: empty agents list -> button is disabled
  harness.reset();
  tree = harness.render({
    agents: [],
    selectedAgentId: 'main',
    onSelectAgent() {},
  });
  const button3 = tree.props.children[0];
  assert.equal(button3.props.disabled, true);
});

test('AgentSwitcher opens portal with model-popup matching styling', () => {
  const harness = createComponentHarness();
  const selectedAgentId = 'agent-1';
  let selected = '';

  const props = {
    agents: [
      { id: 'agent-1', name: 'First Agent' },
      { id: 'agent-2', name: 'agent-2' },
    ],
    selectedAgentId,
    onSelectAgent(id) {
      selected = id;
    },
  };

  // Initially closed: children[1] is false/falsy
  let tree = harness.render(props);
  assert.ok(!tree.props.children[1], 'Portal should not be rendered when isOpen is false');

  // Trigger open by simulating state toggle (slot 0 is isOpen)
  harness.setSlot(0, true);
  tree = harness.render(props);

  const portal = tree.props.children[1];
  assert.ok(portal, 'Portal should be rendered when isOpen is true');
  assert.equal(portal.type, 'portal');

  const popup = portal.props.children;
  assert.equal(popup.props.id, 'agent-selector-popup');
  assert.ok(
    popup.props.className.includes('session-selector-popup') &&
      popup.props.className.includes('model-popup') &&
      popup.props.className.includes('agent-popup'),
    'Popup must share session-selector-popup and model-popup classes'
  );

  const list = popup.props.children[0];
  assert.equal(list.props.className, 'model-popup-list');
  assert.equal(list.props.role, 'listbox');

  // Check agent options inside the list
  const options = list.props.children[0]; // agents.map
  assert.equal(options.length, 2);

  // Option 1: First Agent (agent-1)
  assert.equal(options[0].props.role, 'option');
  assert.equal(options[0].props['aria-selected'], true);
  assert.ok(options[0].props.className.includes('model-popup-option'));

  // Option 2: agent-2
  assert.equal(options[1].props.role, 'option');
  assert.equal(options[1].props['aria-selected'], false);

  // Selecting option 2 triggers onSelectAgent
  options[1].props.onClick();
  assert.equal(selected, 'agent-2');
});
