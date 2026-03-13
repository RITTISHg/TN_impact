from firebase_uploader import fb_put, fb_post, FIREBASE_DATABASE_URL
import datetime

print("Testing Firebase REST writes...")
print(f"Target: {FIREBASE_DATABASE_URL}")

test_data = {
    "timestamp": datetime.datetime.now().isoformat(timespec="seconds"),
    "voltage": 230.5, "current": 2.1, "power": 442.8,
    "energy_kwh": 0.001,
    "anomaly": {"is_anomaly": False, "score": 0.01},
    "fault": {"fault_id": 0, "fault_name": "Normal", "confidence": 0.99},
    "health": {"score": 97.0, "label": "Healthy"},
    "test_mode": True
}

ok1 = fb_put("power_monitor/live", test_data)
print(f"  PUT /live      : {'OK' if ok1 else 'FAILED'}")

key = fb_post("power_monitor/readings", test_data)
print(f"  POST /readings : {'OK key=' + str(key) if key else 'FAILED'}")

ok2 = fb_put("power_monitor/onnx_perf", {"test": True, "timestamp": datetime.datetime.now().isoformat()})
print(f"  PUT /onnx_perf : {'OK' if ok2 else 'FAILED'}")

print("")
print("Check live data at:")
print(f"  {FIREBASE_DATABASE_URL}/power_monitor/live.json")
