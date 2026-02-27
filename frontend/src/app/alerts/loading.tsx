import { SkeletonCard, SkeletonLine } from '@/components/skeleton';

export default function AlertsLoading() {
  return (
    <div className="space-y-6 p-6 anim-fade">
      <SkeletonLine width="160px" height="1.5rem" />
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    </div>
  );
}
