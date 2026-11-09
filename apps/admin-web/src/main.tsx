import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from './app/AppShell';
import { AuthProvider } from './features/auth/AuthContext';
import { LoginPage } from './features/auth/LoginPage';
import { ForgotPasswordPage, ResetPasswordPage, VerifyEmailPage } from './features/auth/RecoveryPages';
import { RequireAuth } from './features/auth/RequireAuth';
import { SecurityPage } from './features/security/SecurityPage';
import { SalonDetailPage } from './features/salons/SalonDetailPage';
import { SalonsPage } from './features/salons/SalonsPage';
import { UsersPage } from './features/users/UsersPage';
import { OverviewPage } from './features/dashboard/OverviewPage';
import { DesignSystemPage } from './features/design-system/DesignSystemPage';
import './index.css';
import { ApiError } from './lib/api';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Never retry client errors (4xx); retry transient failures once.
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 1,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            {/* Public pages (also used by customers / owners following e-mailed links) */}
            <Route path="login" element={<LoginPage />} />
            <Route path="forgot-password" element={<ForgotPasswordPage />} />
            <Route path="reset-password" element={<ResetPasswordPage />} />
            <Route path="verify-email" element={<VerifyEmailPage />} />
            {/* Everything else requires a signed-in platform administrator */}
            <Route element={<RequireAuth />}>
              <Route element={<AppShell />}>
                <Route index element={<OverviewPage />} />
                <Route path="salons" element={<SalonsPage />} />
                <Route path="salons/:id" element={<SalonDetailPage />} />
                <Route path="users" element={<UsersPage />} />
                <Route path="security" element={<SecurityPage />} />
                <Route path="design-system" element={<DesignSystemPage />} />
                <Route path="*" element={<div className="py-20 text-center text-muted">Page not found.</div>} />
              </Route>
            </Route>
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
