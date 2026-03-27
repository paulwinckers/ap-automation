FROM python:3.12-slim

WORKDIR /app

# Install system deps for pdfplumber / pymupdf
RUN apt-get update && apt-get install -y \
    libmupdf-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/
COPY schema.sql ./infrastructure/schema.sql
COPY vendor_rules.csv ./vendor_rules.csv

EXPOSE 8000

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
