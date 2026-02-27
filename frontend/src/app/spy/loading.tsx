import { SkeletonLine, SkeletonCard } from '@/components/skeleton';

export default function SpyLoading() {
  return (
    <div className="space-y-6 p-6 anim-fade">
      <SkeletonLine width="180px" height="1.5rem" />
      <div className="flex gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <SkeletonLine key={i} width="100px" height="2rem" />
        ))}
      </div>
      <div className="space-y-2">
        {Array.from({ length: 10 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    </div>
  );
}
