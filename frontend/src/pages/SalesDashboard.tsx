/**
 * SalesDashboard — embeds the existing Darios Sales Dashboard.
 * Static dashboard served from the portal itself (public/sales-dashboard/) so its data calls
 * carry the portal login. Targets/capacity CSVs live in public/sales-dashboard/data/.
 * Will be migrated to a native React component when Aspire live API is connected.
 */

export default function SalesDashboard() {
  return (
    <iframe
      src="/sales-dashboard/index.html"
      title="Sales Dashboard"
      style={{
        width: '100%',
        height: '100vh',
        border: 'none',
        display: 'block',
      }}
    />
  );
}
