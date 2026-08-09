import React, { memo, useMemo, useState, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { useRequest } from "ahooks";
import { IconVideo } from "@tabler/icons-react";
import type { Components } from "react-markdown";
import { parseSegments, parseColorSegments, extractPaths, checkFilesExist, hasColors, isLocalPath } from "@/lib/text-enrichment";
import { CopyButton } from "@/components/CopyButton";
import { MediaPreviewModal, StreamImagePreview, ImageLoadFail } from "@/components/MediaPreviewModal";
import { getMediaTypeFromSrc } from "@/lib/media-utils";
import { bridge } from "@/services";

interface MarkdownProps {
  content: string;
  className?: string;
  enableEnrichment?: boolean;
  enableLocalImageRender?: boolean;
}

function useIsDark(): boolean {
  const [isDark, setIsDark] = useState(() => typeof document !== "undefined" && document.documentElement.classList.contains("dark"));
  useEffect(() => {
    if (typeof document === "undefined") return;
    const el = document.documentElement;
    const obs = new MutationObserver(() => setIsDark(el.classList.contains("dark")));
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return isDark;
}

function ColorSwatch({ color }: { color: string }) {
  return <span className="inline-block size-2.75 rounded-sm align-middle mr-0.5 mb-0.5" style={{ backgroundColor: color }} />;
}

export function FileLink({ path, display }: { path: string; display: string }) {
  const onClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      void bridge.openFile(path);
    },
    [path],
  );
  return (
    <button type="button" className="hover:text-zinc-900 dark:hover:text-white hover:underline cursor-pointer break-all text-left" onClick={onClick}>
      {display}
    </button>
  );
}

function VideoLink({ src }: { src: string }) {
  const filename = src.split("/").pop() || src;
  return (
    <button
      type="button"
      onClick={() => {
        void bridge.openFile(src);
      }}
      className="inline-flex items-center gap-1.5 px-2 py-1 my-1 rounded bg-muted hover:bg-muted/80 text-xs cursor-pointer"
    >
      <IconVideo className="size-4 text-muted-foreground" />
      <span>{filename}</span>
    </button>
  );
}

function EnrichedText({ text, fileMap }: { text: string; fileMap: Record<string, boolean> }) {
  const segments = useMemo(() => parseSegments(text, fileMap), [text, fileMap]);
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type === "color") {
          return (
            <span key={i}>
              <ColorSwatch color={seg.value} />
              {seg.value}
            </span>
          );
        }
        if (seg.type === "file") {
          return <FileLink key={i} path={seg.path} display={seg.value} />;
        }
        return <span key={i}>{seg.value}</span>;
      })}
    </>
  );
}

function enrichChildren(children: React.ReactNode, fileMap: Record<string, boolean>): React.ReactNode {
  return React.Children.map(children, (child) => {
    if (typeof child === "string") {
      return <EnrichedText text={child} fileMap={fileMap} />;
    }
    if (!React.isValidElement(child)) {
      return child;
    }

    // 跳过链接和代码块（但不跳过行内 code，因为会在 code 组件中单独处理）
    if (typeof child.type === "string" && ["a", "pre"].includes(child.type)) {
      return child;
    }
    const props = child.props as { children?: React.ReactNode };
    if (props.children === undefined) {
      return child;
    }
    return React.cloneElement(child, undefined, enrichChildren(props.children, fileMap));
  });
}

function LocalImage({ src, alt, onPreview }: { src: string; alt?: string; onPreview: (uri: string) => void }) {
  const { data } = useRequest(() => bridge.getImageDataUri(src), {
    cacheKey: `local-image:${src}`,
    staleTime: 10000,
  });

  if (!data) return <ImageLoadFail path={src} />;
  return <StreamImagePreview src={data} alt={alt || src} onPreview={onPreview} />;
}

function ColorEnrichedText({ text }: { text: string }) {
  const segments = useMemo(() => parseColorSegments(text), [text]);
  return (
    <>
      {segments.map((seg, i) =>
        seg.type === "color" ? (
          <span key={i}>
            <ColorSwatch color={seg.value} />
            {seg.value}
          </span>
        ) : (
          <span key={i}>{seg.value}</span>
        ),
      )}
    </>
  );
}

const CodeBlock = memo(function CodeBlock({ code, language, enableHighlight, style }: { code: string; language?: string; enableHighlight: boolean; style?: any }) {
  return (
    <div className="relative group/code">
      <CopyButton content={code} className="absolute right-1 top-1 opacity-0 group-hover/code:opacity-100" />
      {enableHighlight && language ? (
        <SyntaxHighlighter
          style={style}
          language={language}
          PreTag="div"
          customStyle={{ padding: "0.5rem", borderRadius: "0.375rem", fontSize: "11px", margin: 0 }}
          codeTagProps={{ style: { backgroundColor: "transparent", fontFamily: "inherit", padding: 0, color: "inherit", borderRadius: 0 } }}
        >
          {code}
        </SyntaxHighlighter>
      ) : (
        <pre className="bg-muted rounded px-2 py-1 overflow-x-auto text-[11px]">
          <code className="bg-transparent!">{code}</code>
        </pre>
      )}
    </div>
  );
});

// FIX: Replaced unwrapSingleParagraph with unwrapParagraphs.
// The old version only stripped <p> when it was the sole child of <li>.
// In "loose lists" (items separated by blank lines) with nested sub-lists,
// ReactMarkdown produces [<p>, <ul>] as children — two elements — so the
// old single-child check failed and the inner <p mb-2> was kept, adding
// unwanted vertical spacing inside list items.
// This version strips <p> wrappers from ALL children, regardless of count.
function unwrapParagraphs(children: React.ReactNode): React.ReactNode {
  return React.Children.map(children, (child) => {
    if (React.isValidElement(child) && child.type === "p") {
      return (child.props as { children?: React.ReactNode }).children;
    }
    return child;
  });
}

export const Markdown = memo(function Markdown({ content, className, enableEnrichment = true, enableLocalImageRender = true }: MarkdownProps) {
  const isDark = useIsDark();
  const [fileMap, setFileMap] = useState<Record<string, boolean>>({});
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);

  useEffect(() => {
    // When enableEnrichment is false, skip enrichment process
    if (!enableEnrichment || !content) {
      setFileMap({});
      return;
    }
    const paths = extractPaths(content);
    if (!paths.length) {
      setFileMap({});
      return;
    }
    let cancelled = false;
    void checkFilesExist(paths).then((map) => {
      if (!cancelled) {
        setFileMap(map);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [content, enableEnrichment]);

  const codeStyle = isDark ? (oneDark as any) : (oneLight as any);

  const components: Components = useMemo(() => {
    const enrich = (children: React.ReactNode) => (enableEnrichment ? enrichChildren(children, fileMap) : children);
    return {
      p: ({ children }) => <p className="mb-2 last:mb-0">{enrich(children)}</p>,
      li: ({ children }) => <li>{enrich(unwrapParagraphs(children))}</li>,
      strong: ({ children }) => <strong>{enrich(children)}</strong>,
      em: ({ children }) => <em>{enrich(children)}</em>,
      td: ({ children }) => <td className="border border-border px-2 py-1">{enrich(children)}</td>,
      th: ({ children }) => <th className="border border-border bg-muted px-2 py-1 text-left font-medium">{enrich(children)}</th>,
      h1: ({ children }) => <h1 className="text-base font-bold mt-4 mb-2">{children}</h1>,
      h2: ({ children }) => <h2 className="text-sm font-bold mt-3 mb-2">{children}</h2>,
      h3: ({ children }) => <h3 className="text-sm font-semibold mt-2 mb-1">{children}</h3>,
      ul: ({ children }) => <ul className="list-disc list-outside pl-5 mb-2 space-y-1">{children}</ul>,
      ol: ({ children }) => <ol className="list-decimal list-outside pl-5 mb-2 space-y-1">{children}</ol>,
      a: ({ href, children }) => (
        <a href={href} className="text-blue-600 dark:text-blue-400 underline hover:no-underline" target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      ),
      blockquote: ({ children }) => <blockquote className="border-l-2 border-primary/50 pl-3 my-2 text-muted-foreground italic">{children}</blockquote>,
      table: ({ children }) => (
        <div className="overflow-x-auto my-2">
          <table className="min-w-full text-xs border border-border">{children}</table>
        </div>
      ),
      hr: () => <hr className="my-3 border-border" />,
      img: ({ src, alt }) => {
        if (!src) return null;
        if (!enableLocalImageRender) return <span className="text-muted-foreground">{src}</span>;

        if (getMediaTypeFromSrc(src) === "video") {
          return isLocalPath(src) ? <VideoLink src={src} /> : null;
        }
        if (isLocalPath(src)) {
          return <LocalImage src={src} alt={alt} onPreview={setPreviewSrc} />;
        }
        return <StreamImagePreview src={src} alt={alt} onPreview={setPreviewSrc} />;
      },
      code: ({ className: cn, children, ...props }: any) => {
        const match = /language-(\w+)/.exec(cn || "");
        const code = String(children ?? "").replace(/\n$/, "");
        const isInline = !code.includes("\n") && !match;

        if (isInline) {
          const showColor = enableEnrichment && hasColors(code);
          return (
            <code className="bg-muted px-1 py-0.5 rounded text-[11px]" {...props}>
              {showColor ? <ColorEnrichedText text={code} /> : children}
            </code>
          );
        }
        return <CodeBlock code={code} language={match?.[1]} enableHighlight={enableEnrichment && !!match} style={codeStyle} />;
      },
    };
  }, [enableEnrichment, enableLocalImageRender, fileMap, codeStyle]);

  if (!content) return null;

  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={components}>
        {content}
      </ReactMarkdown>
      <MediaPreviewModal src={previewSrc} onClose={() => setPreviewSrc(null)} />
    </div>
  );
});
