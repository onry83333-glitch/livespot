import { SkeletonCard, SkeletonLine } from '@/components/skeleton';

export default function ReportsLoading() {
  return (
    <div className="space-y-6 p-6 anim-fade">
      <SkeletonLine width="160px" height="1.5rem" />
      <div className="space-y-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    </div>
  );
}
