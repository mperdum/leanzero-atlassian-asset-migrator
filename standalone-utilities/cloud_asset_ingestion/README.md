# Cloud Asset Ingestion

Ingests cloud asset data from CSV files into Jira Cloud Assets. Supports multiple asset types with configurable attribute mapping.

## Prerequisites

- Node.js 18+
- Configured `asset-migration-script/.env` (see `asset-migration-script/.env.example`)

## Usage

```bash
cd cloud_asset_ingestion
node main/ingest_cloud_assets.js
```

## Configuration

This script loads environment variables from `asset-migration-script/.env`. See `.env.example` in this directory for required variables.

### CSV Mapping

Asset-to-attribute mappings are defined in `mapping.json`. See `example_mapping.json` for the expected format.

## Folder Structure

- `main/` - Entry point script
- `src/` - Core modules (API client, CSV parser, attribute mapper)
- `mapping.json` - Active attribute mapping configuration
- `example_mapping.json` - Example mapping reference
