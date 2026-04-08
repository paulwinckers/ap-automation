/**
 * OpsDashboard — embeds the existing Darios Ops Dashboard.
 * Hosted at paulwinckers.github.io/sales-dashboard/ops/
 * Will be migrated to a native React component when Aspire live API is connected.
 */

export default function OpsDashboard() {
  return (
    <iframe
      src="https://paulwinckers.github.io/sales-dashboard/ops/"
      title="Operations Dashboard"
      style={{
        width: '100%',
        height: '100vh',
        border: 'none',
        display: 'block',
      }}
    />
  );
}
