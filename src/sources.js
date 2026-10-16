// -----------------------------------------------------------------------------
// What a user types in a scene -> an input or a preset of the player (pure).
//
// "3", "preset 3", "FIP", "Optical Input", "optical", "optique 2", "tv",
// "input:input1", "preset:3"... Case and accents are ignored. The input types
// are the ones of API §11.2 (spdif, analog, coax, bluetooth, arc...), with
// the everyday words for them in English and French.
// -----------------------------------------------------------------------------

const INPUT_WORDS = {
  spdif: ['spdif', 'optical', 'optique', 'toslink', 'opt'],
  analog: ['analog', 'analogue', 'analogique', 'aux', 'line', 'line in', 'ligne', 'entree ligne'],
  coax: ['coax', 'coaxial'],
  bluetooth: ['bluetooth', 'bt'],
  arc: ['arc', 'hdmi', 'hdmi arc', 'tv', 'tele', 'television'],
  earc: ['earc', 'hdmi earc'],
  phono: ['phono', 'vinyl', 'vinyle', 'turntable', 'platine'],
  computer: ['computer', 'usb', 'ordinateur', 'pc'],
  aesebu: ['aesebu', 'aes', 'aes ebu'],
  balanced: ['balanced', 'xlr', 'symetrique'],
  microphone: ['microphone', 'mic', 'micro'],
};

/** Lower case, no accents, single spaces, no punctuation but the digits and letters. */
export function normalize(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9:]+/g, ' ')
    .trim();
}

const unique = (list) => (list.length === 1 ? list[0] : undefined);

/** A preset by its number ("3", "preset 3", "préréglage 3") or its name. */
export function findPreset(query, presets = []) {
  const q = normalize(query);
  if (!q) {
    return undefined;
  }
  const number = /^(?:preset |prereglage |favori |favorite |p)?(\d{1,4})$/.exec(q);
  if (number) {
    return presets.find((p) => p.id === Number(number[1]));
  }
  if (q.startsWith('preset:')) {
    return presets.find((p) => `preset:${p.id}` === q);
  }
  return (
    presets.find((p) => normalize(p.name) === q) ??
    unique(presets.filter((p) => normalize(p.name).includes(q)))
  );
}

/** An input by its option value, id, name, or type word with an optional number ("optical 2"). */
export function findInput(query, inputs = []) {
  const q = normalize(query);
  if (!q) {
    return undefined;
  }
  const exact = inputs.find(
    (i) => `input:${normalize(i.id)}` === q || normalize(i.id) === q || normalize(i.name) === q,
  );
  if (exact) {
    return exact;
  }
  const typed = /^(.*?)(?: (\d{1,2}))?$/.exec(q);
  const word = typed[1];
  const index = typed[2] ? Number(typed[2]) - 1 : 0;
  const type = Object.keys(INPUT_WORDS).find((t) => INPUT_WORDS[t].includes(word));
  if (type) {
    // "hdmi" / "tv": the ARC input, else the eARC one.
    const ofType = [
      ...inputs.filter((i) => i.inputType === type),
      ...(type === 'arc' ? inputs.filter((i) => i.inputType === 'earc') : []),
    ];
    if (ofType[index]) {
      return ofType[index];
    }
  }
  return unique(inputs.filter((i) => normalize(i.name).includes(q)));
}

/**
 * An input or a preset: { kind: 'input', input } | { kind: 'preset', preset } | undefined.
 * The exact names first (an input named like a preset is the input), then
 * the preset numbers, then the input words, then a unique partial name.
 */
export function findSource(query, { presets = [], inputs = [] } = {}) {
  const q = normalize(query);
  if (!q) {
    return undefined;
  }
  if (q.startsWith('preset:') || /^(?:preset |prereglage |favori |favorite |p)?\d{1,4}$/.test(q)) {
    const preset = findPreset(q, presets);
    return preset ? { kind: 'preset', preset } : undefined;
  }
  const exactInput = inputs.find(
    (i) => `input:${normalize(i.id)}` === q || normalize(i.id) === q || normalize(i.name) === q,
  );
  if (exactInput) {
    return { kind: 'input', input: exactInput };
  }
  const exactPreset = presets.find((p) => normalize(p.name) === q);
  if (exactPreset) {
    return { kind: 'preset', preset: exactPreset };
  }
  const input = findInput(q, inputs);
  if (input) {
    return { kind: 'input', input };
  }
  const preset = findPreset(q, presets);
  return preset ? { kind: 'preset', preset } : undefined;
}
