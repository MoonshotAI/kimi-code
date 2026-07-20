import { useState, useEffect } from "react";
import { useExtensionImageUrl } from "./hooks/useExtensionImageUrl";

export function KimiMascot({ className }: { className?: string }) {
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains("dark"));

  useEffect(() => {
    const checkTheme = () => {
      setIsDark(document.documentElement.classList.contains("dark"));
    };

    const observer = new MutationObserver(checkTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => observer.disconnect();
  }, []);

  const imageName = isDark ? "kimi-banner-dark.svg" : "kimi-banner-light.svg";
  const logoUrl = useExtensionImageUrl(imageName);

  if (!logoUrl) {
    return null;
  }

  return <img src={logoUrl} alt="KIMI" className={className} aria-label="KIMI" />;
}
