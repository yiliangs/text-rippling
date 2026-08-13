const OPTION_READERS = {
  string: (value) => value,
  number: (value) => +value,
};

const DATASET_OPTIONS = [
  ['revealMode', OPTION_READERS.string],
  ['revealColor', OPTION_READERS.string],
  ['revealRadius', OPTION_READERS.number],
  ['revealFringe', OPTION_READERS.number],
  ['revealHoldMs', OPTION_READERS.number],
  ['redactRadius', OPTION_READERS.number],
  ['redactFringe', OPTION_READERS.number],
  ['redactTurnoverMs', OPTION_READERS.number],
  ['redactTurnoverFrac', OPTION_READERS.number],
  ['redactColor', OPTION_READERS.string],
  ['burnRadius', OPTION_READERS.number],
  ['burnRate', OPTION_READERS.number],
  ['burnSmolderRate', OPTION_READERS.number],
  ['burnSmolderReach', OPTION_READERS.number],
  ['burnCoolMs', OPTION_READERS.number],
  ['burnEmberColor', OPTION_READERS.string],
  ['burnTwinkleMs', OPTION_READERS.number],
];

const CONTROL_BINDINGS = [
  ['effect', 'effect'],
  ['falloff', 'falloff'],
  ['radius', 'radius', OPTION_READERS.number],
  ['strength', 'strength', OPTION_READERS.number],
  ['spring', 'spring', OPTION_READERS.number],
  ['damping', 'damping', OPTION_READERS.number],
];

// Wire any element with data-effect to a TextRippling instance,
// reading parameters from data-* attributes.
const instances = new Map();
for (const el of document.querySelectorAll('[data-effect]')) {
  const opts = {
    effect: el.dataset.effect || 'repel',
    radius: OPTION_READERS.number(el.dataset.radius) || 160,
    strength: OPTION_READERS.number(el.dataset.strength) || 30,
    falloff: el.dataset.falloff || 'gaussian',
  };

  for (const [key, read] of DATASET_OPTIONS) {
    const value = el.dataset[key];
    if (value) opts[key] = read(value);
  }

  instances.set(el, new TextRippling(el, opts));
}

// Playground controls.
const pg = instances.get(document.getElementById('playground'));
const bind = (id, key, transform = (v) => v) => {
  const input = document.getElementById('ctrl-' + id);
  const out = document.getElementById('out-' + id);
  const apply = () => {
    const v = transform(input.value);
    pg.update({ [key]: v });
    if (out) out.textContent = typeof v === 'number' ? (v % 1 ? v.toFixed(2) : v) : v;
  };
  input.addEventListener('input', apply);
  input.addEventListener('change', apply);
};

for (const binding of CONTROL_BINDINGS) bind(...binding);
