import './styles.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation } from 'react-router';
import { Shell } from './components/shell';
import { Loading } from './components/ui';
import { ApiError, useOverview, useSession } from './lib/api';
import { useLiveUpdates } from './lib/live';
import { ActivityPage } from './pages/activity';
import { AgentsPage } from './pages/agents';
import { IntegrationsPage } from './pages/integrations';
import { MissionPage } from './pages/mission';
import { MissionsPage } from './pages/missions';
import { ProjectsPage } from './pages/projects';
import { SettingsPage } from './pages/settings';
import { SetupPage } from './pages/setup';
import { SignInPage } from './pages/sign-in';
import { TodayPage } from './pages/today';
import { WorkspacePage } from './pages/workspace';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
});

function SessionGate({ children }: { children: ReactNode }) {
  const session = useSession();
  if (session.isPending) return <Loading label="Connecting to Orbit" />;
  if (session.error) return <SignInPage error={session.error} />;
  return <>{children}</>;
}

function Layout() {
  const live = useLiveUpdates(true);
  const overview = useOverview();
  const location = useLocation();
  const needsSetup = overview.data && !overview.data.setup.onboardingComplete && !overview.data.setup.hasRepos;
  if (needsSetup && location.pathname === '/') return <Navigate to="/setup" replace />;
  return (
    <Shell live={live}>
      <Outlet />
    </Shell>
  );
}

const router = createBrowserRouter([
  {
    path: '/setup',
    element: (
      <SessionGate>
        <SetupPage />
      </SessionGate>
    ),
  },
  {
    path: '/',
    element: (
      <SessionGate>
        <Layout />
      </SessionGate>
    ),
    children: [
      { index: true, element: <WorkspacePage /> },
      { path: 's/:id', element: <WorkspacePage /> },
      { path: 'autopilot', element: <TodayPage /> },
      { path: 'ask/*', element: <Navigate to="/" replace /> },
      { path: 'missions', element: <MissionsPage /> },
      { path: 'missions/:id', element: <MissionPage /> },
      { path: 'projects', element: <ProjectsPage /> },
      { path: 'agents', element: <AgentsPage /> },
      { path: 'activity', element: <ActivityPage /> },
      { path: 'integrations', element: <IntegrationsPage /> },
      { path: 'settings', element: <SettingsPage /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
