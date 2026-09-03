import { Languages } from "lucide-react";
import { useLocale } from "@/lib/i18n";
import { LOCALES, dictionaryFor, type Locale } from "@/lib/i18n/locales";

interface Props {
  compact?: boolean;
}

const LanguageSwitcher = ({ compact = false }: Props) => {
  const { locale, setLocale, t } = useLocale();

  return (
    <label className="flex items-center gap-1.5 text-muted-foreground">
      <Languages className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="sr-only">{t.common.language}</span>
      <select
        value={locale}
        onChange={(e) => setLocale(e.target.value as Locale)}
        aria-label={t.common.language}
        className={`bg-transparent border border-border rounded-md py-1 text-foreground hover:bg-accent transition-colors cursor-pointer ${
          compact ? "text-[11px] px-1.5" : "text-xs px-2"
        }`}
      >
        {LOCALES.map((code) => (
          // Each option names its own language in that language, so a reader
          // who cannot read the current UI can still find theirs.
          <option key={code} value={code} className="bg-background text-foreground">
            {dictionaryFor(code).localeName}
          </option>
        ))}
      </select>
    </label>
  );
};

export default LanguageSwitcher;
