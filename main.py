"""
OKX 多账户 Dashboard
主入口文件
"""
import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from api import router, WebSocketManager
from api.websocket import ws_manager
from config import ACCOUNTS
from db import get_db, close_db
from scheduler import start_scheduler, stop_scheduler


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期管理"""
    print(f"Starting Portfolio Monitor with {len(ACCOUNTS)} accounts...")

    # 初始化数据库连接
    await get_db()

    # 启动快照定时任务
    start_scheduler()

    # 启动 OKX WebSocket 连接
    await ws_manager.start_okx_connections()

    yield

    # 停止快照定时任务
    stop_scheduler()

    # 关闭数据库连接
    await close_db()

    # 停止 OKX WebSocket 连接
    print("Shutting down OKX connections...")
    await ws_manager.stop_okx_connections()


app = FastAPI(
    title="OKX Multi-Account Dashboard",
    description="实时监控多个 OKX 账户的资产和仓位",
    version="1.0.0",
    lifespan=lifespan,
)

# 注册 REST API 路由
app.include_router(router)

# 静态文件
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def index():
    """首页"""
    return FileResponse("static/index.html")


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """前端 WebSocket 连接"""
    await ws_manager.connect(websocket)
    try:
        while True:
            # 保持连接，处理前端消息（如果有）
            data = await websocket.receive_text()
            # 可以处理前端发来的消息，如手动刷新请求
            if data == "ping":
                # 统一使用 JSON，避免前端按 JSON 解析时报错
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=9001,
        reload=True,
    )

