import { useEffect } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Icon } from '@zerovity/ui-kit';
import { ItemView } from './ItemView';

/** The work item drawer: opens from any page with ?item=<id> so every item is a deep link (spec 12.2, Floor click). */
export function Drawer() {
  const search = useSearch({ strict: false }) as { item?: string };
  const nav = useNavigate();
  const id = search.item;
  const close = () => void nav({ to: '.', search: (p: Record<string, unknown>) => ({ ...p, item: undefined }) as never });
  useEffect(() => {
    if (!id) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.pal.on')) close(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });
  return (
    <>
      <div className={`scrim${id ? ' on' : ''}`} onClick={close} />
      <aside className={`drawer${id ? ' on' : ''}`} aria-label="Work item" aria-hidden={!id}>
        {id && (
          <>
            <button className="x" onClick={close} aria-label="Close" style={{ position: 'absolute', right: 18, top: 18, zIndex: 3 }}><Icon.Close /></button>
            <ItemView key={id} id={id} variant="drawer" />
          </>
        )}
      </aside>
    </>
  );
}
