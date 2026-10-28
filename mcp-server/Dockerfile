FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY darios_cx_mcp.py oauth_provider.py ./

ENV MCP_TRANSPORT=http
EXPOSE 8000

CMD ["python", "darios_cx_mcp.py"]
