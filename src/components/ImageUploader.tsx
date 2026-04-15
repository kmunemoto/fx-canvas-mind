import { useCallback, useState } from "react";
import { Upload, X, Image as ImageIcon } from "lucide-react";

interface ImageUploaderProps {
  images: File[];
  onImagesChange: (images: File[]) => void;
}

const ImageUploader = ({ images, onImagesChange }: ImageUploaderProps) => {
  const [isDragging, setIsDragging] = useState(false);
  const [previews, setPreviews] = useState<string[]>([]);

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const newFiles = Array.from(files).filter((f) => f.type.startsWith("image/"));
      const combined = [...images, ...newFiles].slice(0, 4);
      onImagesChange(combined);

      combined.forEach((file, i) => {
        if (i >= previews.length) {
          const reader = new FileReader();
          reader.onload = (e) => {
            setPreviews((prev) => {
              const next = [...prev];
              next[i] = e.target?.result as string;
              return next;
            });
          };
          reader.readAsDataURL(file);
        }
      });
    },
    [images, onImagesChange, previews.length]
  );

  const removeImage = (index: number) => {
    onImagesChange(images.filter((_, i) => i !== index));
    setPreviews((prev) => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-3">
      <label className="text-sm font-medium text-foreground flex items-center gap-2">
        <ImageIcon className="h-4 w-4 text-primary" />
        チャート画像（最大4枚）
      </label>
      <div
        className={`glass rounded-xl border-2 border-dashed transition-all cursor-pointer p-8 text-center ${
          isDragging ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
        }`}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => { e.preventDefault(); setIsDragging(false); addFiles(e.dataTransfer.files); }}
        onClick={() => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = "image/*";
          input.multiple = true;
          input.onchange = () => input.files && addFiles(input.files);
          input.click();
        }}
      >
        <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          ドラッグ&ドロップまたはクリックで画像を選択
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          推奨: 15分足・1時間足・4時間足のスクリーンショット
        </p>
      </div>

      {previews.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {previews.map((src, i) => (
            <div key={i} className="relative group rounded-lg overflow-hidden border border-border">
              <img src={src} alt={`Chart ${i + 1}`} className="w-full h-32 object-cover" />
              <button
                onClick={(e) => { e.stopPropagation(); removeImage(i); }}
                className="absolute top-1 right-1 p-1 rounded-full bg-background/80 text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X className="h-3 w-3" />
              </button>
              <div className="absolute bottom-1 left-1 text-xs font-mono bg-background/80 px-1.5 py-0.5 rounded">
                {i + 1}/{previews.length}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ImageUploader;
