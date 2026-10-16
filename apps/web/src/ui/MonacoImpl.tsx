import { useEffect, useRef } from 'react';
import Editor, { loader, type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution';
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution';
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution';
import 'monaco-editor/esm/vs/language/json/monaco.contribution';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import YamlWorker from 'monaco-yaml/yaml.worker?worker';
import { configureMonacoYaml } from 'monaco-yaml';

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker(_: unknown, label: string) { return label === 'yaml' ? new YamlWorker() : label === 'json' ? new JsonWorker() : new EditorWorker(); },
};
loader.config({ monaco });

let yamlReady = false;
function setupYaml() {
  if (yamlReady) return;
  yamlReady = true;
  const base = `${location.origin}/api/v1/schemas/zf/v1alpha1`;
  configureMonacoYaml(monaco, {
    enableSchemaRequest: true, validate: true, completion: true, hover: true, format: true as never,
    schemas: [
      { uri: `${base}/factory.json`, fileMatch: ['**/zerovity.factory.yaml', 'zerovity.factory.yaml'] },
      { uri: `${base}/gates.json`, fileMatch: ['**/policies/gates.yaml', 'policies/gates.yaml'] },
      { uri: `${base}/runner.json`, fileMatch: ['**/runners/*.yaml', 'runners/*.yaml'] },
      { uri: `${base}/context.json`, fileMatch: ['**/context/*.yaml', 'context/*.yaml'] },
      { uri: `${base}/lock.json`, fileMatch: ['**/zerovity.lock', 'zerovity.lock'] },
      { uri: `${base}/pack.json`, fileMatch: ['**/pack.yaml', 'pack.yaml'] },
    ],
  });
}

const themeName = () => ((document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')) === 'light' ? 'zf-light' : 'zf-dark');
let themed = false;
function defineThemes() {
  if (themed) return;
  themed = true;
  const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim() || '#000000';
  const hex = (v: string) => css(v).replace('#', '');
  monaco.editor.defineTheme('zf-dark', { base: 'vs-dark', inherit: true, rules: [], colors: { 'editor.background': '#1e2a40', 'editor.foreground': '#ece6d8', 'editorLineNumber.foreground': '#8d99b0', 'editor.lineHighlightBackground': '#2a3954', 'editorCursor.foreground': '#9ccfec', 'editor.selectionBackground': '#3a4b69' } });
  monaco.editor.defineTheme('zf-light', { base: 'vs', inherit: true, rules: [], colors: { 'editor.background': '#f7f8fb', 'editor.foreground': '#1f2a3f', 'editorLineNumber.foreground': '#7b879d', 'editor.lineHighlightBackground': '#e3e8f0' } });
  void hex;
}

export interface MonacoProps {
  value: string; onChange?: (v: string) => void; language: string; path?: string; readOnly?: boolean; height?: string | number; markers?: Array<{ line: number; col?: number; message: string; severity: 'error' | 'warning' | 'info' }>; onSave?: () => void;
}

export default function MonacoImpl({ value, onChange, language, path, readOnly, height = '100%', markers, onSave }: MonacoProps) {
  const ref = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  useEffect(() => { defineThemes(); if (language === 'yaml') setupYaml(); }, [language]);
  useEffect(() => {
    const obs = new MutationObserver(() => monaco.editor.setTheme(themeName()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  useEffect(() => {
    const model = ref.current?.getModel();
    if (!model) return;
    monaco.editor.setModelMarkers(model, 'zerovity', (markers ?? []).map((m) => ({ startLineNumber: m.line, startColumn: m.col ?? 1, endLineNumber: m.line, endColumn: (m.col ?? 1) + 40, message: m.message, severity: m.severity === 'error' ? monaco.MarkerSeverity.Error : m.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info })));
  }, [markers, path, value]);
  const onMount: OnMount = (ed) => {
    ref.current = ed;
    monaco.editor.setTheme(themeName());
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current?.());
  };
  return (
    <Editor height={height} language={language} path={path} value={value} onChange={(v) => onChange?.(v ?? '')} onMount={onMount} theme={themeName()}
      options={{ readOnly, minimap: { enabled: false }, fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 13, lineNumbersMinChars: 3, scrollBeyondLastLine: false, wordWrap: language === 'markdown' ? 'on' : 'off', renderLineHighlight: 'line', automaticLayout: true, tabSize: 2, padding: { top: 10 } }} />
  );
}
