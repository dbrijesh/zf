import { useEffect, useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';
import type { Pack } from '@zerovity/skills';
import { estimateTokens } from '@zerovity/core';

const FRAMES = ['◐', '◓', '◑', '◒'];
const PHASE_COLORS = ['magenta', 'cyan', 'yellow', 'red', 'green', 'blue'];

export interface InstallChoice { pack: Pack; skills: string[] }

function Banner({ tick }: { tick: number }) {
  const word = 'ZEROVITY FACTORY';
  return (
    <Box marginBottom={1}>
      <Text>{word.split('').map((ch, i) => <Text key={i} color={PHASE_COLORS[(i + tick) % PHASE_COLORS.length]} bold>{ch}</Text>)}</Text>
      <Text dimColor>  skill pack installer</Text>
    </Box>
  );
}

/** Animated pack installer (spec 7.4): choose a pack, then choose which of its skills to include. */
function Installer({ packs, onDone }: { packs: Pack[]; onDone: (c: InstallChoice | null) => void }) {
  const { exit } = useApp();
  const [tick, setTick] = useState(0);
  const [step, setStep] = useState<'pack' | 'skills' | 'confirm'>('pack');
  const [pi, setPi] = useState(0);
  const [si, setSi] = useState(0);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 140); return () => clearInterval(t); }, []);
  const pack = packs[pi];
  const names = pack ? Object.keys(pack.skills) : [];
  const weight = (n: string) => estimateTokens(((pack.skills[n]['SKILL.md'] ?? '').match(/description:.*/)?.[0] ?? '')) ;
  const total = names.filter((n) => picked.has(n)).reduce((a, n) => a + weight(n), 0);

  useInput((input, key) => {
    if (input === 'q' || key.escape) { onDone(null); exit(); return; }
    if (step === 'pack') {
      if (key.upArrow) setPi((pi + packs.length - 1) % packs.length);
      if (key.downArrow) setPi((pi + 1) % packs.length);
      if (key.return && pack) { setPicked(new Set(Object.keys(pack.skills))); setSi(0); setStep('skills'); }
    } else if (step === 'skills') {
      if (key.upArrow) setSi((si + names.length - 1) % names.length);
      if (key.downArrow) setSi((si + 1) % names.length);
      if (input === ' ') { const n = names[si]; const nx = new Set(picked); nx.has(n) ? nx.delete(n) : nx.add(n); setPicked(nx); }
      if (input === 'a') setPicked(new Set(names));
      if (input === 'n') setPicked(new Set());
      if (key.return && picked.size) setStep('confirm');
      if (key.leftArrow) setStep('pack');
    } else if (key.return) { onDone({ pack, skills: [...picked] }); exit(); } else if (key.leftArrow) setStep('skills');
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Banner tick={tick} />
      {step === 'pack' && (
        <>
          <Text bold>Choose a pack <Text dimColor>(↑↓ move, enter select, q quit)</Text></Text>
          {packs.map((p, i) => (
            <Text key={p.manifest.name + p.manifest.version} color={i === pi ? 'cyan' : undefined}>{i === pi ? `${FRAMES[tick % 4]} ` : '  '}{p.manifest.name}@{p.manifest.version} <Text dimColor>{Object.keys(p.skills).length} skills, {Object.keys(p.agents).length} agents · {p.manifest.description.slice(0, 70)}</Text></Text>
          ))}
        </>
      )}
      {step === 'skills' && pack && (
        <>
          <Text bold>{pack.manifest.name}: include which skills? <Text dimColor>(space toggle, a all, n none, enter continue, ← back)</Text></Text>
          {names.map((n, i) => (
            <Text key={n} color={i === si ? 'cyan' : undefined}>{i === si ? '▸ ' : '  '}{picked.has(n) ? '[x]' : '[ ]'} {n} <Text dimColor>{weight(n)} tokens always loaded</Text></Text>
          ))}
          <Text dimColor>{picked.size} of {names.length} selected · {total} tokens added to every agent that lists them</Text>
        </>
      )}
      {step === 'confirm' && pack && (
        <>
          <Text bold>Ready to install</Text>
          <Text>{pack.manifest.name}@{pack.manifest.version}: {[...picked].join(', ')}</Text>
          <Text dimColor>Adds a packs entry to zerovity.factory.yaml and pins zerovity.lock. enter to install, ← back, q cancel.</Text>
        </>
      )}
    </Box>
  );
}

export async function runInstaller(packs: Pack[]): Promise<InstallChoice | null> {
  return new Promise((resolve) => {
    let result: InstallChoice | null = null;
    const app = render(<Installer packs={packs} onDone={(c) => { result = c; }} />);
    void app.waitUntilExit().then(() => resolve(result));
  });
}
