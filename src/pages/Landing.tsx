import { useNavigate, Link } from "react-router-dom";
import { motion } from "framer-motion";
import {
  Zap, BarChart3, Clock, Brain, Download, Sparkles, Scale,
  ChevronRight, Check, Star, ArrowRight, Share2, Link as LinkIcon, MessageCircle, Check as CheckIcon,
  ClipboardCheck, Search, RefreshCw, ShieldQuestion,
} from "lucide-react";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { toast } from "sonner";
import {
  Accordion, AccordionContent, AccordionItem, AccordionTrigger,
} from "@/components/ui/accordion";
import { useT } from "@/lib/i18n";
import LanguageSwitcher from "@/components/LanguageSwitcher";

const fadeUp = {
  hidden: { opacity: 0, y: 30 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.6, ease: "easeOut" as const } },
};

const stagger = {
  visible: { transition: { staggerChildren: 0.15 } },
};

const PLANS = [
  { id: "light", name: "Light", price: "¥2,980", recommended: false },
  { id: "standard", name: "Standard", price: "¥5,980", recommended: true },
  { id: "pro", name: "Pro", price: "¥12,800", recommended: false },
] as const;

const SHARE_URL = "https://fx-tactical.jp";

const ShareSection = () => {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const SHARE_TEXT = t.lp.shareText;

  const onTwitter = () => {
    const url = `https://twitter.com/intent/tweet?text=${encodeURIComponent(SHARE_TEXT)}&url=${encodeURIComponent(SHARE_URL)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const onLine = () => {
    const url = `https://social-plugins.line.me/lineit/share?url=${encodeURIComponent(SHARE_URL)}&text=${encodeURIComponent(SHARE_TEXT)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(SHARE_URL);
      setCopied(true);
      toast.success(t.blog.copiedToast);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t.blog.copyFailed);
    }
  };

  const baseBtn =
    "inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl font-semibold text-sm transition-all";

  return (
    <section aria-label={t.lp.aria.share} className="py-16 md:py-20">
      <div className="container max-w-3xl mx-auto px-4 text-center">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-[#00d4ff]/10 mb-4">
          <Share2 className="h-6 w-6 text-[#00d4ff]" aria-hidden="true" />
        </div>
        <h2 className="text-2xl md:text-3xl font-bold mb-3">{t.lp.shareTitle}</h2>
        <p className="text-sm text-muted-foreground mb-8">
          {t.lp.shareBody}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3">
          <button
            onClick={onTwitter}
            aria-label={t.blog.shareX}
            className={`${baseBtn} bg-gradient-to-r from-[#00d4ff] to-[#0088ff] text-[#0a0e17] hover:opacity-90 shadow-[0_0_20px_rgba(0,212,255,0.25)]`}
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
            {t.blog.shareX}
          </button>
          <button
            onClick={onLine}
            aria-label={t.blog.shareLine}
            className={`${baseBtn} border border-[#00d4ff]/40 bg-[#00d4ff]/10 text-[#00d4ff] hover:bg-[#00d4ff]/20`}
          >
            <MessageCircle className="h-4 w-4" aria-hidden="true" />
            {t.blog.shareLine}
          </button>
          <button
            onClick={onCopy}
            aria-label={t.blog.copyLink}
            className={`${baseBtn} border border-white/10 bg-white/5 text-foreground hover:border-[#00d4ff]/40 hover:text-[#00d4ff]`}
          >
            {copied ? <CheckIcon className="h-4 w-4" aria-hidden="true" /> : <LinkIcon className="h-4 w-4" aria-hidden="true" />}
            {copied ? t.blog.copied : t.blog.copyLink}
          </button>
        </div>
      </div>
    </section>
  );
};

// Proof for a visitor who cannot sign in and try it.
//
// Analysis is now paid-only, so the landing page is the only place a stranger
// can see that the learning loop is real. The rulebook's version and its
// last-changed time are the honest evidence: only the post-mortem
// consolidation moves them, so they cannot be staged from here. The RPC
// returns counts and nothing else — no rule text, no per-user row, and no
// win rate, which the sample is nowhere near large enough to support.
interface TrackRecord {
  rulebook_version: number;
  rules: number;
  updated_at: string | null;
}

const LoopSection = () => {
  const t = useT();
  const [record, setRecord] = useState<TrackRecord | null>(null);

  useEffect(() => {
    let live = true;
    supabase.rpc("public_track_record").then(({ data, error }) => {
      if (!live || error || !data) return;
      const r = data as TrackRecord;
      // A rulebook that has never been revised proves nothing, so the badge
      // stays hidden rather than announcing "v0"
      if (typeof r.rulebook_version === "number" && r.rulebook_version > 0) setRecord(r);
    });
    return () => { live = false; };
  }, []);

  const updated = record?.updated_at
    ? new Date(record.updated_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
    : "";

  return (
    <Section ariaLabel={t.lp.aria.loop}>
      <SectionTitle>{t.lp.loopTitle}</SectionTitle>
      <motion.p
        variants={fadeUp} initial="hidden" whileInView="visible" viewport={{ once: true }}
        className="text-center text-muted-foreground max-w-2xl mx-auto -mt-6 mb-12"
      >
        {t.lp.loopBody}
      </motion.p>

      <motion.div
        className="grid grid-cols-1 md:grid-cols-3 gap-6"
        variants={stagger} initial="hidden" whileInView="visible" viewport={{ once: true }}
      >
        {[ClipboardCheck, Search, RefreshCw].map((Icon, i) => {
          const { title, desc } = t.lp.loopSteps[i];
          return (
            <motion.article key={title} variants={fadeUp} className="glass rounded-2xl p-8 border border-white/5">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-[#00d4ff]/10 mb-4">
                <Icon className="h-6 w-6 text-[#00d4ff]" aria-hidden="true" />
              </div>
              <h3 className="text-lg font-bold mb-2">{title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">{desc}</p>
            </motion.article>
          );
        })}
      </motion.div>

      {record && (
        <motion.div
          variants={fadeUp} initial="hidden" whileInView="visible" viewport={{ once: true }}
          className="mt-8 text-center"
          data-testid="rulebook-live"
        >
          <span className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-[#00d4ff]/30 bg-[#00d4ff]/5 font-mono-data text-sm text-[#00d4ff]">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            {t.lp.loopLive(record.rulebook_version, record.rules, updated)}
          </span>
          <p className="text-xs text-muted-foreground mt-3">{t.lp.loopLiveNote}</p>
        </motion.div>
      )}

      <motion.aside
        variants={fadeUp} initial="hidden" whileInView="visible" viewport={{ once: true }}
        className="glass rounded-2xl border border-white/5 p-8 mt-12 max-w-3xl mx-auto"
      >
        <div className="flex items-start gap-4">
          <ShieldQuestion className="h-6 w-6 text-[#00d4ff] shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <h3 className="text-lg font-bold mb-2">{t.lp.honestTitle}</h3>
            <p className="text-sm text-muted-foreground leading-relaxed">{t.lp.honestBody}</p>
          </div>
        </div>
      </motion.aside>
    </Section>
  );
};

const Landing = () => {
  const t = useT();
  const navigate = useNavigate();
  const goSignup = () => navigate("/login?tab=signup");
  const goLogin = () => navigate("/login");

  return (
    <div className="min-h-screen bg-[#0a0e17] text-foreground overflow-x-hidden">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-white/5 bg-[#0a0e17]/80 backdrop-blur-xl">
        <div className="container max-w-6xl mx-auto flex items-center justify-between px-4 h-16">
          <div className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-[#00d4ff]" aria-hidden="true" />
            <span className="font-bold text-lg tracking-tight">FX Tactical Analyzer</span>
          </div>
          <nav aria-label={t.lp.aria.nav} className="flex items-center gap-3">
            <LanguageSwitcher compact />
            <a href="#features" className="hidden md:inline text-sm text-muted-foreground hover:text-foreground transition-colors">{t.lp.nav.features}</a>
            <a href="#pricing" className="hidden md:inline text-sm text-muted-foreground hover:text-foreground transition-colors">{t.lp.nav.pricing}</a>
            <a href="#faq" className="hidden md:inline text-sm text-muted-foreground hover:text-foreground transition-colors">{t.lp.nav.faq}</a>
            <Link to="/blog" className="hidden md:inline text-sm text-muted-foreground hover:text-foreground transition-colors">{t.landing.blog}</Link>
            <button onClick={goLogin} className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              {t.landing.login}
            </button>
            <button
              onClick={goSignup}
              className="text-sm font-semibold px-4 py-2 rounded-lg bg-[#00d4ff] text-[#0a0e17] hover:opacity-90 transition-opacity"
            >
              {t.landing.startFree}
            </button>
          </nav>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section aria-label={t.lp.aria.hero} className="relative py-24 md:py-36 overflow-hidden">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_rgba(0,212,255,0.08)_0%,_transparent_70%)]" />
          <div className="absolute inset-0 opacity-[0.03]" style={{
            backgroundImage: "linear-gradient(rgba(255,255,255,.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.1) 1px, transparent 1px)",
            backgroundSize: "60px 60px",
          }} />
          <motion.div
            className="relative container max-w-4xl mx-auto px-4 text-center"
            initial="hidden" animate="visible" variants={stagger}
          >
            <motion.h1 variants={fadeUp} className="text-4xl md:text-6xl font-bold leading-tight mb-6">
              {t.lp.heroBefore}<span className="text-[#00d4ff]">{t.lp.heroHighlight}</span>{t.lp.heroAfter}<br className="md:hidden" />
              {t.lp.heroLine2}
            </motion.h1>
            <motion.p variants={fadeUp} className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto mb-10">
              {t.lp.subtitleBefore}<span className="font-mono-data text-foreground">{t.lp.subtitleCount}</span>{t.lp.subtitleAfter}
            </motion.p>
            <motion.div variants={fadeUp} className="flex flex-col items-center gap-4">
              <button
                onClick={goSignup}
                className="px-8 py-4 rounded-xl text-lg font-bold bg-gradient-to-r from-[#00d4ff] to-[#0088ff] text-[#0a0e17] hover:opacity-90 transition-opacity shadow-[0_0_30px_rgba(0,212,255,0.3)]"
              >
                {t.landing.startFree} <ArrowRight className="inline h-5 w-5 ml-1" aria-hidden="true" />
              </button>
              <span className="text-sm text-muted-foreground">{t.lp.noCard}</span>
            </motion.div>
          </motion.div>
        </section>

        {/* Pain Points */}
        <Section ariaLabel={t.lp.aria.pain}>
          <SectionTitle>{t.lp.painTitle}</SectionTitle>
          <motion.div className="grid grid-cols-1 md:grid-cols-3 gap-6" variants={stagger} initial="hidden" whileInView="visible" viewport={{ once: true }}>
            {[BarChart3, Clock, Brain].map((Icon, i) => {
              const text = t.lp.pains[i];
              return (
              <motion.div key={text} variants={fadeUp} className="glass rounded-2xl p-8 text-center border border-white/5">
                <div className="inline-flex items-center justify-center w-14 h-14 rounded-xl bg-[#00d4ff]/10 mb-5">
                  <Icon className="h-7 w-7 text-[#00d4ff]" aria-hidden="true" />
                </div>
                <p className="text-lg font-semibold">{text}</p>
              </motion.div>
              );
            })}
          </motion.div>
        </Section>

        {/* Features */}
        <Section id="features" ariaLabel={t.lp.aria.features}>
          <SectionTitle>{t.lp.featuresTitle}</SectionTitle>
          <motion.div className="grid grid-cols-1 md:grid-cols-3 gap-6" variants={stagger} initial="hidden" whileInView="visible" viewport={{ once: true }}>
            {[Download, Sparkles, Scale].map((Icon, i) => {
              const { title, desc } = t.lp.features[i];
              return (
              <motion.article key={title} variants={fadeUp} className="glass rounded-2xl p-8 border border-white/5">
                <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-[#00d4ff]/10 mb-4">
                  <Icon className="h-6 w-6 text-[#00d4ff]" aria-hidden="true" />
                </div>
                <h3 className="text-lg font-bold mb-2">{title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">{desc}</p>
              </motion.article>
              );
            })}
          </motion.div>
        </Section>

        {/* Steps */}
        <Section ariaLabel={t.lp.aria.steps}>
          <SectionTitle>{t.lp.stepsTitle}</SectionTitle>
          <motion.div className="grid grid-cols-1 md:grid-cols-3 gap-8" variants={stagger} initial="hidden" whileInView="visible" viewport={{ once: true }}>
            {["01", "02", "03"].map((num, i) => {
              const { title, sub } = t.lp.steps[i];
              return (
              <motion.div key={num} variants={fadeUp} className="text-center">
                <span className="font-mono-data text-4xl font-bold text-[#00d4ff]/30">{num}</span>
                <h3 className="text-lg font-bold mt-2 mb-1">{title}</h3>
                <p className="text-sm text-muted-foreground">{sub}</p>
              </motion.div>
              );
            })}
          </motion.div>
        </Section>

        {/* Pricing */}
        <Section id="pricing" ariaLabel={t.lp.aria.pricing}>
          <SectionTitle>{t.lp.pricingTitle}</SectionTitle>
          <motion.div className="grid grid-cols-1 md:grid-cols-3 gap-6" variants={stagger} initial="hidden" whileInView="visible" viewport={{ once: true }}>
            {PLANS.map((plan) => (
              <motion.div
                key={plan.id}
                variants={fadeUp}
                className={`relative glass rounded-2xl border p-6 flex flex-col ${
                  plan.recommended ? "border-[#00d4ff] ring-2 ring-[#00d4ff]/20" : "border-white/5"
                }`}
              >
                {plan.recommended && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 flex items-center gap-1 px-3 py-1 rounded-full bg-[#00d4ff] text-[#0a0e17] text-xs font-semibold">
                    <Star className="h-3 w-3" aria-hidden="true" /> {t.pricing.recommended}
                  </div>
                )}
                <h3 className="text-xl font-bold mb-1">{plan.name}</h3>
                <div className="flex items-baseline gap-1 mb-6">
                  <span className="text-3xl font-bold font-mono-data">{plan.price}</span>
                  <span className="text-sm text-muted-foreground">{t.pricing.perMonth}</span>
                </div>
                <ul className="space-y-3 mb-6 flex-1">
                  {t.pricing.features[plan.id].map((f) => (
                    <li key={f} className="flex items-start gap-2 text-sm">
                      <Check className="h-4 w-4 text-[#00d4ff] mt-0.5 shrink-0" aria-hidden="true" /> {f}
                    </li>
                  ))}
                </ul>
                <button
                  onClick={() => navigate(`/login?tab=signup&plan=${plan.id}`)}
                  className={`w-full py-3 rounded-xl font-semibold text-sm transition-all ${
                    plan.recommended
                      ? "bg-gradient-to-r from-[#00d4ff] to-[#0088ff] text-[#0a0e17] hover:opacity-90"
                      : "border border-[#00d4ff]/40 bg-[#00d4ff]/10 text-[#00d4ff] hover:bg-[#00d4ff]/20"
                  }`}
                >
                  {t.lp.choosePlan}
                </button>
              </motion.div>
            ))}
          </motion.div>
          <div className="text-center mt-8">
            <button
              onClick={() => navigate("/pricing")}
              className="text-sm text-[#00d4ff] hover:underline inline-flex items-center gap-1"
            >
              {t.lp.pricingDetails} <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        </Section>

        {/* How the loop works */}
        <LoopSection />

        {/* FAQ */}
        <Section id="faq" ariaLabel={t.lp.aria.faq}>
          <SectionTitle>{t.lp.faqTitle}</SectionTitle>
          <motion.div variants={fadeUp} initial="hidden" whileInView="visible" viewport={{ once: true }} className="max-w-2xl mx-auto">
            <Accordion type="single" collapsible className="space-y-2">
              {t.lp.faqs.map((faq, i) => (
                <AccordionItem key={i} value={`faq-${i}`} className="glass rounded-xl border border-white/5 px-6">
                  <AccordionTrigger className="text-left hover:no-underline">
                    {faq.q}
                  </AccordionTrigger>
                  <AccordionContent className="text-muted-foreground">
                    {faq.a}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </motion.div>
        </Section>

        {/* Final CTA */}
        <section aria-label={t.lp.aria.cta} className="relative py-24">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_rgba(0,212,255,0.06)_0%,_transparent_70%)]" />
          <motion.div
            className="relative container max-w-3xl mx-auto px-4 text-center"
            variants={stagger} initial="hidden" whileInView="visible" viewport={{ once: true }}
          >
            <motion.h2 variants={fadeUp} className="text-3xl md:text-4xl font-bold mb-4">
              {t.lp.ctaTitle}
            </motion.h2>
            <motion.p variants={fadeUp} className="text-muted-foreground mb-8">
              {t.lp.ctaBody}
            </motion.p>
            <motion.div variants={fadeUp}>
              <button
                onClick={goSignup}
                className="px-8 py-4 rounded-xl text-lg font-bold bg-gradient-to-r from-[#00d4ff] to-[#0088ff] text-[#0a0e17] hover:opacity-90 transition-opacity shadow-[0_0_30px_rgba(0,212,255,0.3)]"
              >
                {t.landing.startFree} <ArrowRight className="inline h-5 w-5 ml-1" aria-hidden="true" />
              </button>
            </motion.div>
          </motion.div>
        </section>

        {/* Social Share */}
        <ShareSection />
      </main>

      {/* Footer */}
      <footer className="border-t border-white/5 py-10">
        <div className="container max-w-6xl mx-auto px-4">
          <div className="flex flex-col md:flex-row items-center justify-between gap-6">
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-[#00d4ff]" aria-hidden="true" />
              <span className="text-sm font-semibold">FX Tactical Analyzer</span>
              <span className="text-xs text-muted-foreground ml-2">© 2026</span>
            </div>
            <nav aria-label={t.lp.aria.footerNav} className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
              <Link to="/blog" className="hover:text-foreground transition-colors">{t.landing.blog}</Link>
              <Link to="/terms" className="hover:text-foreground transition-colors">{t.landing.terms}</Link>
              <Link to="/privacy" className="hover:text-foreground transition-colors">{t.landing.privacy}</Link>
              <Link to="/legal" className="hover:text-foreground transition-colors">{t.landing.tokushoho}</Link>
              <Link to="/contact" className="hover:text-foreground transition-colors">{t.landing.contact}</Link>
            </nav>
          </div>
          <p className="text-xs text-muted-foreground/60 text-center mt-6">
            {t.landing.footerNote}
          </p>
        </div>
      </footer>
    </div>
  );
};

const Section = ({ children, id, ariaLabel }: { children: React.ReactNode; id?: string; ariaLabel?: string }) => (
  <section id={id} aria-label={ariaLabel} className="py-20 md:py-28">
    <div className="container max-w-6xl mx-auto px-4">{children}</div>
  </section>
);

const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <motion.h2
    variants={fadeUp} initial="hidden" whileInView="visible" viewport={{ once: true }}
    className="text-2xl md:text-3xl font-bold text-center mb-12"
  >
    {children}
  </motion.h2>
);

export default Landing;
