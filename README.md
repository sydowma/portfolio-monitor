# OKX Portfolio Monitor

A real-time multi-account dashboard for monitoring OKX trading accounts. Track balances, positions, orders, and bills across multiple accounts with WebSocket live updates.

## Features

- **Multi-Account Support** - Monitor multiple OKX accounts simultaneously (live & demo)
- **Real-Time Updates** - WebSocket-based live data streaming for account, positions, and orders
- **Portfolio Overview** - Total equity, available balance, margin used, unrealized PnL
- **Position Tracking** - SWAP positions with entry price, mark price, PnL, leverage, liquidation price
- **Order Management** - View pending orders and historical orders with pagination
- **Bill History** - Fund flow records with filtering by type and instrument
- **Proxy Support** - SOCKS5/HTTPS proxy for both REST and WebSocket connections

## Quick Start

### 1. Install Dependencies

```bash
pip install -r requirements.txt
# or with uv
uv sync
```

### 2. Configure Accounts

Create a `.env` file with your OKX API credentials:

```env
# Account 1
OKX_ACCOUNT_1_NAME=Main
OKX_ACCOUNT_1_API_KEY=your-api-key
OKX_ACCOUNT_1_SECRET_KEY=your-secret-key
OKX_ACCOUNT_1_PASSPHRASE=your-passphrase
OKX_ACCOUNT_1_SIMULATED=false

# Account 2 (optional)
OKX_ACCOUNT_2_NAME=Demo
OKX_ACCOUNT_2_API_KEY=your-demo-api-key
OKX_ACCOUNT_2_SECRET_KEY=your-demo-secret-key
OKX_ACCOUNT_2_PASSPHRASE=your-demo-passphrase
OKX_ACCOUNT_2_SIMULATED=true

# Proxy (optional)
all_proxy=socks5://127.0.0.1:1080
```

### 3. Run

```bash
python main.py
# or
uvicorn main:app --host 0.0.0.0 --port 8080 --reload
```

Open http://localhost:8080 in your browser.

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/accounts` | List all configured accounts |
| `GET /api/accounts/{id}/balance` | Get account balance and assets |
| `GET /api/accounts/{id}/positions` | Get SWAP positions |
| `GET /api/accounts/{id}/pending-orders` | Get pending orders |
| `GET /api/accounts/{id}/orders` | Get order history (paginated) |
| `GET /api/accounts/{id}/bills` | Get bill records (paginated) |
| `GET /api/summary` | Get all accounts summary |
| `WS /ws` | WebSocket for real-time updates |

## Tech Stack

- **Backend**: FastAPI, Pydantic, httpx, websockets
- **Frontend**: Vanilla HTML/JS
- **Runtime**: Python 3.11+
