'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import { TextStyle } from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import Highlight from '@tiptap/extension-highlight';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import type { SupabaseClient } from '@supabase/supabase-js';

interface TipTapEditorProps {
  value: Record<string, unknown> | null;
  onChange: (json: Record<string, unknown>) => void;
  sb: SupabaseClient;
  editable?: boolean;
  /** Supabase Storage にアップロード時のパスプレフィックス */
  uploadPrefix: string;
}

const TEXT_COLORS = [
  { label: '白', value: '#e2e8f0' },
  { label: '黄', value: '#facc15' },
  { label: '橙', value: '#fb923c' },
  { label: '赤', value: '#f87171' },
  { label: '桃', value: '#f472b6' },
  { label: '紫', value: '#c084fc' },
  { label: '青', value: '#60a5fa' },
  { label: '水', value: '#22d3ee' },
  { label: '緑', value: '#4ade80' },
];

const HIGHLIGHT_COLORS = [
  { label: '黄', value: 'rgba(234,179,8,0.3)' },
  { label: '青', value: 'rgba(56,189,248,0.3)' },
  { label: '緑', value: 'rgba(34,197,94,0.3)' },
  { label: '桃', value: 'rgba(244,114,182,0.3)' },
];

/**
 * クリップボード画像を Supabase Storage にアップロード。
 * 公開 URL を返す。
 */
async function uploadImage(
  sb: SupabaseClient,
  file: File,
  prefix: string,
): Promise<string | null> {
  const ext = (file.name.split('.').pop() || 'png').toLowerCase();
  const name = `${prefix}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await sb.storage
    .from('cast-calendar-notes')
    .upload(name, file, { cacheControl: '3600', upsert: false });
  if (error) {
    console.error('[TipTapEditor] upload error:', error.message);
    return null;
  }
  const { data } = sb.storage.from('cast-calendar-notes').getPublicUrl(name);
  return data.publicUrl;
}

// ============================================================
// Toolbar
// ============================================================
function Toolbar({
  editor,
  sb,
  uploadPrefix,
}: {
  editor: Editor;
  sb: SupabaseClient;
  uploadPrefix: string;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const pickImage = useCallback(() => fileInputRef.current?.click(), []);
  const onFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      const url = await uploadImage(sb, file, uploadPrefix);
      if (url) editor.chain().focus().setImage({ src: url }).run();
    },
    [editor, sb, uploadPrefix],
  );

  const setLink = useCallback(() => {
    const prev = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('URL', prev || 'https://');
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }, [editor]);

  const btnStyle =
    'px-2 py-1 rounded text-[11px] transition-colors hover:bg-white/10';
  const activeStyle = { background: 'rgba(56,189,248,0.2)', color: '#38bdf8' };

  return (
    <div
      className="flex flex-wrap items-center gap-1 px-2 py-1.5 rounded-t-lg"
      style={{
        background: 'rgba(255,255,255,0.03)',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <button type="button" onClick={() => editor.chain().focus().toggleBold().run()}
        className={btnStyle} style={editor.isActive('bold') ? activeStyle : undefined} title="太字">
        <b>B</b>
      </button>
      <button type="button" onClick={() => editor.chain().focus().toggleItalic().run()}
        className={btnStyle} style={editor.isActive('italic') ? activeStyle : undefined} title="斜体">
        <i>I</i>
      </button>
      <button type="button" onClick={() => editor.chain().focus().toggleStrike().run()}
        className={btnStyle} style={editor.isActive('strike') ? activeStyle : undefined} title="取り消し線">
        <s>S</s>
      </button>
      <button type="button" onClick={() => editor.chain().focus().toggleCode().run()}
        className={btnStyle} style={editor.isActive('code') ? activeStyle : undefined} title="インラインコード">
        {'<>'}
      </button>

      <span className="w-px h-4 bg-white/10 mx-1" />

      <button type="button" onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        className={btnStyle} style={editor.isActive('heading', { level: 1 }) ? activeStyle : undefined} title="見出し1">
        H1
      </button>
      <button type="button" onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        className={btnStyle} style={editor.isActive('heading', { level: 2 }) ? activeStyle : undefined} title="見出し2">
        H2
      </button>
      <button type="button" onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        className={btnStyle} style={editor.isActive('heading', { level: 3 }) ? activeStyle : undefined} title="見出し3">
        H3
      </button>

      <span className="w-px h-4 bg-white/10 mx-1" />

      <button type="button" onClick={() => editor.chain().focus().toggleBulletList().run()}
        className={btnStyle} style={editor.isActive('bulletList') ? activeStyle : undefined} title="箇条書き">
        • List
      </button>
      <button type="button" onClick={() => editor.chain().focus().toggleOrderedList().run()}
        className={btnStyle} style={editor.isActive('orderedList') ? activeStyle : undefined} title="番号付きリスト">
        1. List
      </button>
      <button type="button" onClick={() => editor.chain().focus().toggleTaskList().run()}
        className={btnStyle} style={editor.isActive('taskList') ? activeStyle : undefined} title="チェックボックス">
        ☑
      </button>
      <button type="button" onClick={() => editor.chain().focus().toggleBlockquote().run()}
        className={btnStyle} style={editor.isActive('blockquote') ? activeStyle : undefined} title="引用">
        ❝
      </button>
      <button type="button" onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        className={btnStyle} style={editor.isActive('codeBlock') ? activeStyle : undefined} title="コードブロック">
        {'{ }'}
      </button>

      <span className="w-px h-4 bg-white/10 mx-1" />

      {/* 文字色 */}
      <div className="flex items-center gap-0.5">
        {TEXT_COLORS.map((c) => (
          <button
            key={c.value}
            type="button"
            onClick={() => editor.chain().focus().setColor(c.value).run()}
            className="w-4 h-4 rounded-full transition-transform hover:scale-125"
            style={{ background: c.value, border: '1px solid rgba(255,255,255,0.2)' }}
            title={`文字色: ${c.label}`}
          />
        ))}
        <button type="button" onClick={() => editor.chain().focus().unsetColor().run()}
          className={btnStyle} title="文字色解除">✕</button>
      </div>

      <span className="w-px h-4 bg-white/10 mx-1" />

      {/* 背景色 */}
      <div className="flex items-center gap-0.5">
        {HIGHLIGHT_COLORS.map((c) => (
          <button
            key={c.value}
            type="button"
            onClick={() => editor.chain().focus().toggleHighlight({ color: c.value }).run()}
            className="w-4 h-4 rounded transition-transform hover:scale-125"
            style={{ background: c.value, border: '1px solid rgba(255,255,255,0.2)' }}
            title={`背景色: ${c.label}`}
          />
        ))}
        <button type="button" onClick={() => editor.chain().focus().unsetHighlight().run()}
          className={btnStyle} title="背景色解除">✕</button>
      </div>

      <span className="w-px h-4 bg-white/10 mx-1" />

      <button type="button" onClick={setLink}
        className={btnStyle} style={editor.isActive('link') ? activeStyle : undefined} title="リンク">
        🔗
      </button>
      <button type="button" onClick={pickImage} className={btnStyle} title="画像挿入">
        🖼
      </button>
      <button
        type="button"
        onClick={() =>
          editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
        }
        className={btnStyle}
        title="表を挿入"
      >
        ▦
      </button>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onFile}
      />
    </div>
  );
}

// ============================================================
// Main Editor
// ============================================================
export default function TipTapEditor({
  value,
  onChange,
  sb,
  editable = true,
  uploadPrefix,
}: TipTapEditorProps) {
  // 親から渡される onChange が再生成されても edit サイクルを壊さないように ref に保持
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Link.configure({ openOnClick: false, autolink: true }),
      Image.configure({ inline: false, allowBase64: false }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    content: value && Object.keys(value).length > 0 ? value : { type: 'doc', content: [{ type: 'paragraph' }] },
    editable,
    editorProps: {
      attributes: {
        class:
          'tiptap-prose focus:outline-none min-h-[160px] px-3 py-2 text-sm leading-relaxed',
      },
      handlePaste: (view, event) => {
        const items = event.clipboardData?.items;
        if (!items) return false;
        for (const item of Array.from(items)) {
          if (item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (!file) continue;
            event.preventDefault();
            (async () => {
              const url = await uploadImage(sb, file, uploadPrefix);
              if (url && editor) editor.chain().focus().setImage({ src: url }).run();
            })();
            return true;
          }
        }
        return false;
      },
    },
    onUpdate: ({ editor }) => {
      onChangeRef.current(editor.getJSON() as Record<string, unknown>);
    },
    // SSR 時のハイドレーション不一致を回避
    immediatelyRender: false,
  });

  // editable プロパティの変更を反映
  useEffect(() => {
    if (editor) editor.setEditable(editable);
  }, [editor, editable]);

  if (!editor) {
    return (
      <div
        className="rounded-lg min-h-[200px] flex items-center justify-center text-xs"
        style={{ background: 'rgba(255,255,255,0.03)', color: 'var(--text-muted)' }}
      >
        エディタ初期化中...
      </div>
    );
  }

  return (
    <div
      className="rounded-lg overflow-hidden"
      style={{
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      {editable && <Toolbar editor={editor} sb={sb} uploadPrefix={uploadPrefix} />}
      <EditorContent editor={editor} />
    </div>
  );
}
