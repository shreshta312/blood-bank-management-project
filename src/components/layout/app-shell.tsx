"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useUser, SignedIn, SignedOut, SignInButton, UserButton } from "@clerk/nextjs";
import { navigationRole } from "@/lib/session";
import Icon from "@/components/ds/icons";
import HealthIndicator from "@/components/ds/health-indicator";
import { adminNav, labsNav, primaryNav, visible, type NavItem } from "@/components/ds/nav";

const TITLES: [string, string][] = [
  ["/emergencies", "Emergencies"], ["/inventory", "Inventory"], ["/institutions", "Hospitals & banks"], ["/donors", "Donors"], ["/reports", "Reports"], ["/admin", "Administration"], ["/system", "System"],
];
const isActive = (path: string, href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));
// Everything that is not an operational page lives under Labs in the navigation.
const isOperational = (path: string) => path === "/" || TITLES.some(([p]) => path.startsWith(p));

function NavLinks({ items, path, onNavigate }: { items: NavItem[]; path: string; onNavigate: () => void }) {
  return <>{items.map(item => {
    const active = isActive(path, item.href);
    return <Link key={item.href} href={item.href} className={`ds-nav-link${active ? " is-active" : ""}`} aria-current={active ? "page" : undefined} onClick={onNavigate}><Icon name={item.icon} />{item.label}</Link>;
  })}</>;
}

function Navigation({ path, close, role }: { path: string; close: () => void; role: import("@/lib/session").Role | null }) {
  const admin = visible(adminNav, role);
  const labsActive = !isOperational(path);
  return <>
    <nav>
      <div className="ds-nav-group"><NavLinks items={visible(primaryNav, role)} path={path} onNavigate={close} /></div>
      {admin.length > 0 && <div className="ds-nav-group"><p className="ds-nav-heading">Manage</p><NavLinks items={admin} path={path} onNavigate={close} /></div>}
    </nav>
    <div className="ds-sidebar-foot">
      {visible([labsNav], role).length > 0 && <Link href={labsNav.href} className={`ds-nav-link${labsActive ? " is-active" : ""}`} onClick={close}><Icon name="labs" />Labs</Link>}
    </div>
  </>;
}
function ClerkNavigation({ path, close }: { path: string; close: () => void }) {
  const clerk = useUser();
  const role = clerk.isLoaded && clerk.isSignedIn ? navigationRole(clerk.user.publicMetadata) : null;
  return <Navigation path={path} close={close} role={role} />;
}
function RoleNavigation({ path, close, configured }: { path: string; close: () => void; configured: boolean }) {
  return configured ? <ClerkNavigation path={path} close={close} /> : <Navigation path={path} close={close} role={null} />;
}

export function AppShell({ children, authConfigured = false }: { children: React.ReactNode; authConfigured?: boolean }) {
  const path = usePathname();
  // The menu is open only for the page it was opened on, so navigating closes it.
  const [openFor, setOpenFor] = useState<string | null>(null);
  const open = openFor === path;
  const setOpen = (v: boolean) => setOpenFor(v ? path : null);
  const section = path === "/" ? "Overview" : TITLES.find(([p]) => path.startsWith(p))?.[1] ?? "Labs";
  const close = () => setOpen(false);

  return (
    <div className="ds-shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className={`ds-sidebar${open ? " is-open" : ""}`} aria-label="Primary">
        <Link href="/" className="ds-brand" aria-label="PulseGrid home" onClick={close}>
          <span className="ds-brand-mark" aria-hidden="true">P</span>
          <span>PulseGrid<small>Blood bank network</small></span>
        </Link>
        <RoleNavigation path={path} close={close} configured={authConfigured} />
      </aside>
      {open && <button className="ds-scrim" aria-label="Close menu" onClick={close} />}
      <div className="ds-workspace">
        <header className="ds-topbar">
          <button className="ds-menu-btn" aria-label={open ? "Close menu" : "Open menu"} aria-expanded={open} onClick={() => setOpen(!open)}><Icon name={open ? "close" : "menu"} /></button>
          <p className="ds-topbar-title">{section}</p>
          <HealthIndicator />
          {authConfigured && (
            <div className="ds-auth-controls" style={{ display: "flex", alignItems: "center", gap: "8px", marginLeft: "12px" }}>
              <SignedIn>
                <UserButton />
              </SignedIn>
              <SignedOut>
                <SignInButton mode="modal">
                  <button className="ds-btn ds-btn-small ds-btn-quiet">Sign in</button>
                </SignInButton>
              </SignedOut>
            </div>
          )}
        </header>
        <main id="main-content" tabIndex={-1} className="ds-main">{children}</main>
      </div>
    </div>
  );
}
