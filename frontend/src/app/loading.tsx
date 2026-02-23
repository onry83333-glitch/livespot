export default function Loading() {
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <div className="text-center space-y-4">
        <div className="relative w-12 h-12 mx-auto">
          <div className="absolute inset-0 rounded-full border-2 border-transparent"
            style={{
              borderTopColor: 'var(--accent-primary)',
              animation: 'spin 0.8s linear infinite',
            }}
          />
          <div className="absolute inset-1.5 rounded-full border-2 border-transparent"
            style={{
              borderTopColor: 'var(--accent-primary)',
              opacity: 0.4,
              animation: 'spin 1.2s linear infinite reverse',
            }}
          />
        </div>
        <p className="text-sm font-medium" style={{ color: 'var(--text-muted)' }}>
          読み込み中...
        </p>
      </div>
    </div>
  );
}
