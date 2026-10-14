#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
保单缴费提醒后台服务
无需打开窗口，通过任务计划程序自动运行
支持 Server酱、钉钉机器人、企业微信机器人

使用方法:
    python policy_notification_service.py              # 检查并发送提醒
    python policy_notification_service.py --test     # 发送测试通知
    python policy_notification_service.py --config   # 显示当前配置
    python policy_notification_service.py --setup    # 配置通知
"""

import json
import os
import re
import requests
import argparse
from datetime import datetime, timedelta, date as _date
from typing import List, Dict, Optional

# 获取脚本所在目录
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
JS_FILE = os.path.join(SCRIPT_DIR, 'data.js')
JSON_FILE = os.path.join(SCRIPT_DIR, 'data.json')
CONFIG_FILE = os.path.join(SCRIPT_DIR, '.policy_notification_config.json')


def extract_policies() -> List[dict]:
    """从 data.js 提取 initialPolicies 并保存为 data.json，返回列表"""
    if not os.path.exists(JS_FILE):
        return []

    with open(JS_FILE, 'r', encoding='utf-8') as f:
        content = f.read()

    match = re.search(r'initialPolicies\s*=\s*(\[)', content)
    if not match:
        return []

    start = match.start(1)  # [ 的位置
    depth = 0
    for i in range(start, len(content)):
        c = content[i]
        if c == '[':
            depth += 1
        elif c == ']':
            depth -= 1
        if depth == 0:
            end = i + 1
            break

    policies_str = content[start:end]
    json_str = _js_to_json(policies_str)
    policies = json.loads(json_str)

    # 保存为 JSON，下次直接读
    with open(JSON_FILE, 'w', encoding='utf-8') as f:
        json.dump(policies, f, ensure_ascii=False, indent=2)

    return policies


def _js_to_json(js_str: str) -> str:
    """将简化的 JS 对象数组转换为 JSON"""
    result = []
    i = 0
    n = len(js_str)
    while i < n:
        c = js_str[i]
        if c == "'":
            j = i + 1
            while j < n:
                if js_str[j] == '\\':
                    j += 2
                    continue
                if js_str[j] == "'":
                    break
                j += 1
            inner = js_str[i+1:j]
            inner = inner.replace('\\', '\\\\').replace('"', '\\"')
            result.append('"' + inner + '"')
            i = j + 1
        elif c == '"':
            j = i + 1
            while j < n:
                if js_str[j] == '\\':
                    j += 2
                    continue
                if js_str[j] == '"':
                    break
                j += 1
            result.append(js_str[i:j+1])
            i = j + 1
        elif c == '=':
            result.append(':')
            i += 1
        elif c == ';':
            result.append(',')
            i += 1
        else:
            result.append(c)
            i += 1
    s = ''.join(result)
    # 裸键名（: 前面的标识符）加上双引号
    # 处理 , key: 和 { key: 两种情况
    s = re.sub(r'([{,]\s*)([a-zA-Z_]\w*)(\s*:)', r'\1"\2"\3', s)
    # 移除数组元素之间的 trailing comma
    s = re.sub(r',(\s*])', r'\1', s)
    return s


class PolicyNotificationService:

    def __init__(self):
        self.policies = self._load_policies()
        self.config = self._load_config()
        self.default_reminder_days = [30, 15, 7, 3, 0]

    def _load_policies(self) -> List[dict]:
        if os.path.exists(JSON_FILE):
            try:
                with open(JSON_FILE, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                if isinstance(data, list):
                    return data
                return data.get('policies', [])
            except Exception as e:
                print(f"读取 data.json 失败 ({e})，尝试从 data.js 提取...")

        # 从 data.js 提取
        policies = extract_policies()
        if policies:
            print(f"已从 data.js 提取 {len(policies)} 份保单，保存到 data.json")
        return policies

    def _load_config(self) -> dict:
        # GitHub Actions 环境变量优先级最高
        env_type = os.environ.get('DINGTALK_TYPE', '')
        env_webhook = os.environ.get('DINGTALK_WEBHOOK', '')
        env_secret = os.environ.get('DINGTALK_SECRET', '')
        env_days = os.environ.get('REMINDER_DAYS', '')

        if env_type == 'dingtalk' and env_webhook:
            config = {
                'type': 'dingtalk',
                'dingtalkWebhook': env_webhook,
                'dingtalkSecret': env_secret,
                'reminderDays': [int(d) for d in env_days.split(',')] if env_days else [30, 15, 7, 3, 0]
            }
            return config

        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except:
                pass
        return {}

    def _save_config(self):
        with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump(self.config, f, ensure_ascii=False, indent=2)

    def _reminder_days(self) -> List[int]:
        return self.config.get('reminderDays', self.default_reminder_days)

    def _sent_records(self) -> set:
        path = os.path.join(SCRIPT_DIR, '.sent_policy_reminders.json')
        if os.path.exists(path):
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    return set(json.load(f).get('sent', []))
            except:
                pass
        return set()

    def _save_sent(self, records: set):
        path = os.path.join(SCRIPT_DIR, '.sent_policy_reminders.json')
        with open(path, 'w', encoding='utf-8') as f:
            json.dump({'sent': sorted(records)}, f, ensure_ascii=False, indent=2)

    def check_payment_reminders(self) -> List[Dict]:
        reminders = []
        today = datetime.combine(_date.today(), datetime.min.time())
        sent = self._sent_records()
        days_list = self._reminder_days()

        for p in self.policies:
            npd = p.get('nextPaymentDate', '')
            if not npd or npd in ('终身', '终身寿险', '—') or '/' in npd:
                continue
            if not re.match(r'\d{4}-\d{2}-\d{2}', npd):
                continue

            try:
                np_date = datetime.strptime(npd, '%Y-%m-%d')
            except:
                continue

            if np_date < today and days_until != 0:
                continue

            days_until = (np_date - today).days

            for d in days_list:
                key = f"pay_{p.get('id')}_{npd}_{d}"
                if key not in sent and days_until == d:
                    reminders.append({
                        'key': key,
                        'id': p.get('id'),
                        'productName': p.get('productName', ''),
                        'insured': p.get('insured', ''),
                        'insurer': p.get('insurer', ''),
                        'annualPremium': p.get('annualPremium', ''),
                        'nextPaymentDate': npd,
                        'days_until': days_until,
                        'reminder_days': d,
                    })
        return reminders

    def check_expiry_reminders(self) -> List[Dict]:
        reminders = []
        today = datetime.combine(_date.today(), datetime.min.time())
        sent = self._sent_records()
        days_list = self._reminder_days()

        for p in self.policies:
            ed = p.get('expiryDate', '')
            if not ed or ed in ('终身', '终身寿险') or '/' in ed:
                continue
            if not re.match(r'\d{4}-\d{2}-\d{2}', ed):
                continue

            try:
                ex_date = datetime.strptime(ed, '%Y-%m-%d')
            except:
                continue

            days_until = (ex_date - today).days
            if days_until < 0:
                continue

            for d in days_list:
                key = f"exp_{p.get('id')}_{ed}_{d}"
                if key not in sent and days_until == d:
                    reminders.append({
                        'key': key,
                        'id': p.get('id'),
                        'productName': p.get('productName', ''),
                        'insured': p.get('insured', ''),
                        'insurer': p.get('insurer', ''),
                        'expiryDate': ed,
                        'days_until': days_until,
                        'reminder_days': d,
                    })
        return reminders

    def _send_serverchan(self, title: str, content: str, key: str) -> bool:
        try:
            resp = requests.post(
                f"https://sctapi.ftqq.com/{key}.send",
                data={'title': title, 'content': content},
                timeout=10
            )
            result = resp.json()
            return result.get('code') == 0 or result.get('errno') == 0
        except Exception as e:
            print(f"Server酱发送失败: {e}")
            return False

    def _send_dingtalk(self, title: str, content: str, webhook: str, secret: str = None) -> bool:
        try:
            import hmac, hashlib, base64, urllib.parse
            url = webhook
            if secret:
                timestamp = str(round(__import__('time').time() * 1000))
                sign_str = f"{timestamp}\n{secret}"
                sign = base64.b64encode(
                    hmac.new(secret.encode(), sign_str.encode(), hashlib.sha256).digest()
                ).decode()
                url = f"{webhook}&timestamp={timestamp}&sign={urllib.parse.quote(sign)}"

            dingtalk_content = content.replace('### ', '## ').replace('**', '').replace('`', '')
            payload = {
                "msgtype": "markdown",
                "markdown": {"title": title, "text": dingtalk_content}
            }
            resp = requests.post(url, json=payload, timeout=10)
            result = resp.json()
            if result.get('errcode') == 0:
                return True
            print(f"钉钉错误: errcode={result.get('errcode')}, errmsg={result.get('errmsg')}")
            return False
        except Exception as e:
            print(f"钉钉发送异常: {e}")
            return False

    def _send_wechatwork(self, content: str, webhook: str) -> bool:
        try:
            resp = requests.post(
                webhook,
                json={"msgtype": "markdown", "markdown": {"content": content}},
                timeout=10
            )
            return resp.json().get('errcode') == 0
        except Exception as e:
            print(f"企业微信发送失败: {e}")
            return False

    def _send(self, title: str, content: str) -> bool:
        ntype = self.config.get('type', '')
        if ntype == 'serverchan':
            key = self.config.get('serverchanKey', '')
            if not key:
                print("错误: 未配置 Server酱 SendKey")
                return False
            return self._send_serverchan(title, content, key)
        elif ntype == 'dingtalk':
            webhook = self.config.get('dingtalkWebhook', '')
            secret = self.config.get('dingtalkSecret', '')
            if not webhook:
                print("错误: 未配置钉钉 Webhook")
                return False
            return self._send_dingtalk(title, content, webhook, secret)
        elif ntype == 'wechatwork':
            webhook = self.config.get('wechatworkWebhook', '')
            if not webhook:
                print("错误: 未配置企业微信 Webhook")
                return False
            return self._send_wechatwork(content, webhook)
        else:
            print("错误: 未配置通知方式")
            return False

    def _generate_message(self, payments: List, expiries: List) -> Optional[str]:
        if not payments and not expiries:
            return None
        lines = [f"📅 {datetime.now().strftime('%Y年%m月%d日')} 家庭保单提醒\n"]

        if payments:
            lines.append("### 💰 待缴费保单")
            for item in sorted(payments, key=lambda x: x['nextPaymentDate']):
                premium = item.get('annualPremium', '')
                premium_str = f"¥{float(premium):,.0f}" if premium and premium not in ('—', '') else '—'
                when_str = "**今天**" if item['days_until'] == 0 else f"还有 **{item['days_until']}** 天"
                lines.append(
                    f"- **{item['productName']}**\n"
                    f"  被保人: {item['insured']} | 保费: {premium_str}\n"
                    f"  缴费日: `{item['nextPaymentDate']}`, {when_str}\n"
                    f"  保险公司: {item['insurer']}"
                )

        if expiries:
            lines.append("\n### ⏰ 保障即将到期")
            for item in sorted(expiries, key=lambda x: x['expiryDate']):
                when_str = "**今天到期**" if item['days_until'] == 0 else f"还有 **{item['days_until']}** 天"
                lines.append(
                    f"- **{item['productName']}**\n"
                    f"  被保人: {item['insured']} | 保险公司: {item['insurer']}\n"
                    f"  到期日: `{item['expiryDate']}`, {when_str}"
                )

        return '\n\n'.join(lines)

    def run(self) -> bool:
        print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] 开始检查保单提醒...")

        if not self.config.get('type'):
            print("未配置通知方式，跳过发送")
            print("请先运行 python policy_notification_service.py --setup 配置")
            return False

        if not self.policies:
            print("未找到保单数据")
            return False

        payments = self.check_payment_reminders()
        expiries = self.check_expiry_reminders()

        if not payments and not expiries:
            print("暂无需要提醒的事项")
            return True

        print(f"发现 {len(payments)} 条缴费提醒, {len(expiries)} 条到期提醒")

        message = self._generate_message(payments, expiries)
        if not message:
            print("消息生成失败")
            return False

        print("正在发送通知...")
        success = self._send('🏠 家庭保单提醒通知', message)

        if success:
            sent = self._sent_records()
            for item in payments:
                sent.add(item['key'])
            for item in expiries:
                sent.add(item['key'])
            self._save_sent(sent)
            print("通知发送成功!")
        else:
            print("通知发送失败")

        return success

    def test(self) -> bool:
        print("发送测试通知...")
        if not self.config.get('type'):
            print("错误: 未配置通知方式")
            return False
        msg = (
            "### 🧪 测试通知\n\n"
            f"> 家庭保单管理系统通知服务测试\n\n"
            f"> 时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n"
            "> 如果您看到此消息，说明通知配置正确!"
        )
        ok = self._send('保单管理系统 - 测试通知', msg)
        print("测试通知发送成功!" if ok else "测试通知发送失败")
        return ok

    def setup(self) -> bool:
        print("\n=== 保单提醒通知配置 ===\n")
        print("支持的通知方式:")
        print("  1. 钉钉机器人（推荐）")
        print("  2. Server酱（推送至微信）")
        print("  3. 企业微信机器人")
        print()
        choice = input("请选择 (1/2/3，直接回车退出): ").strip()
        if not choice:
            return False

        self.config = self._load_config()

        if choice == '1':
            self.config['type'] = 'dingtalk'
            webhook = input("请输入钉钉 Webhook 地址: ").strip()
            if not webhook:
                print("Webhook 不能为空，配置取消")
                return False
            self.config['dingtalkWebhook'] = webhook
            secret = input("加签密钥（可选，直接回车跳过）: ").strip()
            self.config['dingtalkSecret'] = secret
        elif choice == '2':
            self.config['type'] = 'serverchan'
            key = input("请输入 Server酱 SendKey: ").strip()
            if not key:
                print("SendKey 不能为空，配置取消")
                return False
            self.config['serverchanKey'] = key
        elif choice == '3':
            self.config['type'] = 'wechatwork'
            webhook = input("请输入企业微信 Webhook 地址: ").strip()
            if not webhook:
                print("Webhook 不能为空，配置取消")
                return False
            self.config['wechatworkWebhook'] = webhook
        else:
            print("无效选择")
            return False

        days_input = input("提前几天提醒？(多个天数用空格分隔，如: 3 7): ").strip()
        try:
            self.config['reminderDays'] = sorted([int(d) for d in days_input.split()]) if days_input else [3, 7]
        except ValueError:
            self.config['reminderDays'] = [3, 7]

        self._save_config()
        print("\n✓ 配置已保存!")
        self.test()
        return True

    def show_config(self):
        print("\n=== 当前配置 ===\n")
        ntype = self.config.get('type', '')
        names = {'serverchan': 'Server酱 (微信)', 'dingtalk': '钉钉机器人', 'wechatwork': '企业微信机器人', '': '未配置'}
        print(f"通知方式: {names.get(ntype, ntype)}")
        if ntype == 'dingtalk':
            print(f"Webhook: {'已配置' if self.config.get('dingtalkWebhook') else '未配置'}")
            print(f"加签密钥: {'已配置' if self.config.get('dingtalkSecret') else '未配置'}")
        elif ntype == 'serverchan':
            k = self.config.get('serverchanKey', '')
            print(f"SendKey: {k[:8]}...{k[-4:]}" if len(k) > 12 else k if k else '未配置')
        elif ntype == 'wechatwork':
            print(f"Webhook: {'已配置' if self.config.get('wechatworkWebhook') else '未配置'}")
        print(f"提前提醒: {self._reminder_days()} 天")
        print(f"保单数量: {len(self.policies)} 份")
        print()


def main():
    parser = argparse.ArgumentParser(description='保单缴费提醒后台服务')
    parser.add_argument('--test', action='store_true', help='发送测试通知')
    parser.add_argument('--config', action='store_true', help='显示当前配置')
    parser.add_argument('--setup', action='store_true', help='配置通知')
    args = parser.parse_args()

    svc = PolicyNotificationService()
    if args.setup:
        svc.setup()
    elif args.test:
        svc.test()
    elif args.config:
        svc.show_config()
    else:
        svc.run()


if __name__ == '__main__':
    main()
