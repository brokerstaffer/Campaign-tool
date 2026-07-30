import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Analytics — BrokerStaffer",
  description: "Campaign analytics and management",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // No `dark` class and no ThemeProvider — light-only, see globals.css.
  return (
    <html lang="en">
      <body className={`${inter.variable} font-sans antialiased`}>
        {children}
        <Toaster richColors closeButton position="bottom-right" />
      </body>
    </html>
  );
}
