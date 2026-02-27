import { SkeletonKPI, SkeletonTable, SkeletonLine } from '@/components/skeleton';

export default function CastsLoading() {
  return (
    <div className="space-y-6 p-6 anim-fade">
      <SkeletonLine width="160px" height="1.5rem" />
      <SkeletonKPI count={3} />
      <SkeletonTable rows={5} cols={5} />
    </div>
  );
}
