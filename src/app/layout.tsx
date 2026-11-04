
import type { Metadata, Viewport } from "next";
import { AppShell } from "@/components/layout/app-shell";
import { DemoDataProvider } from "@/components/providers/demo-data-provider";
import "./globals.css";
import { ClerkProvider } from "@clerk/nextjs";

export const metadata: Metadata = {
  title: { default: "PulseGrid", template: "%s | PulseGrid" },
  description: "Blood bank inventory and emergency coordination.",
  robots: { index: false, follow: false },
  icons: { icon: "/icon.svg", apple: "/donor-192.png" },
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "PulseGrid",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b0507",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const authConfigured = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY);
  const app = <AppShell authConfigured={authConfigured}>{children}</AppShell>;
  return <html lang="en"><body>{authConfigured ? <ClerkProvider>{app}</ClerkProvider> : app}</body></html>;
}
