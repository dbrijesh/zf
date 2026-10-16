import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, createRootRoute, createRoute, createRouter, Outlet, redirect } from '@tanstack/react-router';
import '@fontsource-variable/space-grotesk';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/600.css';
import '@zerovity/ui-kit/tokens.css';
import './mock.css';
import './app.css';
import { api, queryClient, ApiError, type Me } from './api';
import { AppProvider } from './state';
import { Shell } from './Shell';
import { LoginPage } from './pages/Login';
import { FloorPage } from './pages/Floor';

const L = <T extends Record<string, unknown>>(f: () => Promise<T>, k: keyof T) => lazy(async () => ({ default: (await f())[k] as React.ComponentType }));
const InboxPage = L(() => import('./pages/Inbox'), 'InboxPage');
const ItemsPage = L(() => import('./pages/Items'), 'ItemsPage');
const ItemPage = L(() => import('./pages/Items'), 'ItemPage');
const RunsPage = L(() => import('./pages/Items'), 'RunsPage');
const RunPage = L(() => import('./pages/RunPage'), 'RunPage');
const AgentsPage = L(() => import('./pages/Agents'), 'AgentsPage');
const SkillsPage = L(() => import('./pages/Skills'), 'SkillsPage');
const ContextPage = L(() => import('./pages/ContextLibrary'), 'ContextPage');
const DefinitionPage = L(() => import('./pages/Definition'), 'DefinitionPage');
const DashboardPage = L(() => import('./pages/Dashboard'), 'DashboardPage');
const ScorersPage = L(() => import('./pages/Scorers'), 'ScorersPage');
const ConnectionsPage = L(() => import('./pages/Connections'), 'ConnectionsPage');
const SettingsPage = L(() => import('./pages/Settings'), 'SettingsPage');

const root = createRootRoute({ component: Outlet });
const login = createRoute({ getParentRoute: () => root, path: '/login', component: LoginPage });
const authed = createRoute({
  getParentRoute: () => root, id: 'authed',
  beforeLoad: async () => { try { await queryClient.fetchQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me'), staleTime: 30_000 }); } catch (e) { if (e instanceof ApiError && e.status === 401) throw redirect({ to: '/login' }); throw e; } },
  component: function Authed() {
    const me = queryClient.getQueryData<Me>(['me'])!;
    return <AppProvider me={me}><Shell /></AppProvider>;
  },
});
const page = <P extends string>(path: P, C: React.ComponentType) => createRoute({ getParentRoute: () => authed, path, component: C as never });
const tree = root.addChildren([login, authed.addChildren([
  page('/', FloorPage), page('/inbox', InboxPage), page('/items', ItemsPage), page('/items/$id', ItemPage), page('/runs', RunsPage), page('/runs/$id', RunPage),
  page('/agents', AgentsPage), page('/skills', SkillsPage), page('/context', ContextPage), page('/definition', DefinitionPage), page('/dashboard', DashboardPage),
  page('/scorers', ScorersPage), page('/connections', ConnectionsPage), page('/settings', SettingsPage),
])]);
const router = createRouter({ routeTree: tree, defaultPreload: 'intent', defaultNotFoundComponent: () => <div className="emptyblock"><div>Page not found.</div></div> });
declare module '@tanstack/react-router' { interface Register { router: typeof router } }

createRoot(document.getElementById('root')!).render(
  <StrictMode><QueryClientProvider client={queryClient}><Suspense fallback={null}><RouterProvider router={router} /></Suspense></QueryClientProvider></StrictMode>,
);
