import { useState } from "react";
import { Mail, Send } from "lucide-react";
import LegalPageLayout from "@/components/LegalPageLayout";
import { toast } from "@/hooks/use-toast";

const Contact = () => {
  const [form, setForm] = useState({ name: "", email: "", subject: "", message: "" });
  const [sending, setSending] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSending(true);
    setTimeout(() => {
      toast({ title: "送信完了", description: "お問い合わせを受け付けました。3営業日以内にご返信いたします。" });
      setForm({ name: "", email: "", subject: "", message: "" });
      setSending(false);
    }, 1000);
  };

  return (
    <LegalPageLayout title="お問い合わせ">
      <p>ご質問、ご要望、不具合の報告などがございましたら、以下のフォームよりお気軽にお問い合わせください。3営業日以内にご返信いたします。</p>

      <div className="flex items-center gap-2 text-sm text-muted-foreground mt-2 mb-8">
        <Mail className="h-4 w-4" />
        <span>メール: support@fx-tactical-analyzer.com</span>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        {[
          { id: "name", label: "お名前", type: "text", placeholder: "山田 太郎" },
          { id: "email", label: "メールアドレス", type: "email", placeholder: "taro@example.com" },
          { id: "subject", label: "件名", type: "text", placeholder: "お問い合わせ内容の件名" },
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
          <label htmlFor="message" className="block text-sm font-semibold text-foreground mb-1.5">お問い合わせ内容</label>
          <textarea
            id="message"
            required
            rows={6}
            placeholder="お問い合わせ内容を入力してください"
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
          {sending ? "送信中..." : "送信する"}
        </button>
      </form>
    </LegalPageLayout>
  );
};

export default Contact;
