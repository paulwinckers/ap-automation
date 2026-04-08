/**
 * SalesDashboard — embeds the existing Darios Sales Dashboard.
 * Hosted at paulwinckers.github.io/sales-dashboard/
 * Will be migrated to a native React component when Aspire live API is connected.
 */

export default function SalesDashboard() {
  return (
    <iframe
      src="https://paulwinckers.github.io/sales-dashboard/"
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
