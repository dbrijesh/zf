import { Component, lazy, Suspense, type ReactNode } from 'react';
import type { MonacoProps } from './MonacoImpl';
import { Spinner } from '@zerovity/ui-kit';

const Monaco = lazy(() => import('./MonacoImpl'));

class Boundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

/** Monaco, loaded on demand. If it cannot load (blocked worker, old browser) a plain textarea keeps editing possible. */
export function CodeEditor(p: MonacoProps) {
  const plain = (
    <textarea className="plainedit mono" value={p.value} readOnly={p.readOnly} spellCheck={false} aria-label="Editor" onChange={(e) => p.onChange?.(e.target.value)} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); p.onSave?.(); } }} style={{ height: p.height ?? '100%' }} />
  );
  return (
    <Boundary fallback={plain}>
      <Suspense fallback={<div className="editorload"><Spinner /> Loading editor…</div>}>
        <Monaco {...p} />
      </Suspense>
    </Boundary>
  );
}
