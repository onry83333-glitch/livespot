import { SkeletonCard, SkeletonLine } from '@/components/skeleton';

export default function FeedLoading() {
  return (
    <div className="space-y-6 p-6 anim-fade">
      <SkeletonLine width="120px" height="1.5rem" />
      <div className="space-y-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    </div>
  );
}
