import { useState } from "react";
import { Mail, Send } from "lucide-react";
import { useT } from "@/lib/i18n";
import LegalPageLayout from "@/components/LegalPageLayout";
import { toast } from "@/hooks/use-toast";

const Contact = () => {
  const t = useT();
  const [form, setForm] = useState({ name: "", email: "", subject: "", message: "" });
  const [sending, setSending] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSending(true);
    setTimeout(() => {
      toast({ title: t.contact.sentTitle, description: t.contact.sentBody });
      setForm({ name: "", email: "", subject: "", message: "" });
      setSending(false);
    }, 1000);
  };

  return (
    <LegalPageLayout title={t.contact.title}>
      <p>{t.contact.intro}</p>

      <div className="flex items-center gap-2 text-sm text-muted-foreground mt-2 mb-8">
        <Mail className="h-4 w-4" />
        <span>{t.contact.mail}</span>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {[
          { id: "name", label: t.contact.name, type: "text", placeholder: t.contact.namePlaceholder },
          { id: "email", label: t.contact.email, type: "email", placeholder: "you@example.com" },
          { id: "subject", label: t.contact.subject, type: "text", placeholder: t.contact.subjectPlaceholder },
        ].map(({ id, label, type, placeholder }) => (
          <div key={id}>
            <label htmlFor={id} className="block text-sm font-semibold text-foreground mb-1.5">{label}</label>
            <input
              id={id}
              type={type}
              required
              placeholder={placeholder}
              value={form[id as keyof typeof form]}
              onChange={(e) => setForm((p) => ({ ...p, [id]: e.target.value }))}
              className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>
        ))}
        <div>
          <label htmlFor="message" className="block text-sm font-semibold text-foreground mb-1.5">{t.contact.message}</label>
          <textarea
            id="message"
            required
            rows={6}
            placeholder={t.contact.messagePlaceholder}
            value={form.message}
            onChange={(e) => setForm((p) => ({ ...p, message: e.target.value }))}
            className="w-full rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
          />
        </div>
        <button
          type="submit"
          disabled={sending}
          className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-primary text-primary-foreground font-semibold text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          <Send className="h-4 w-4" />
          {sending ? t.contact.sending : t.contact.send}
        </button>
      </form>
    </LegalPageLayout>
  );
};

export default Contact;
