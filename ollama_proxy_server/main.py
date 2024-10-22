import argparse
import configparser
import csv
import datetime
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from queue import Queue
from socketserver import ThreadingMixIn
from urllib.parse import parse_qs, urlparse

import requests
from ascii_colors import ASCIIColors


def get_config(filename):
    config = configparser.ConfigParser()
    config.read(filename)
    servers = []
    for name in config.sections():
        server_info = {
            'url': config[name]['url'],
            'queue': Queue(),
            'models': [model.strip() for model in config[name]['models'].split(',')]
        }
        servers.append((name, server_info))
    ASCIIColors.green(f"Loaded servers from {filename}: {servers}")
    return servers

# Read the authorized users and their keys from a file
def get_authorized_users(filename):
    with open(filename, 'r') as f:
        lines = f.readlines()
    authorized_users = {}
    for line in lines:
        if line.strip() == "":
            continue
        try:
            user, key = line.strip().split(':')
            authorized_users[user] = key
        except:
            ASCIIColors.red(f"User entry broken: {line.strip()}")
    ASCIIColors.green(f"Loaded authorized users from {filename}: {list(authorized_users.keys())}")
    return authorized_users

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', default="config.ini", help='Path to the config file')
    parser.add_argument('--log_path', default="access_log.txt", help='Path to the access log file')
    parser.add_argument('--users_list', default="authorized_users.txt", help='Path to the authorized users list')
    parser.add_argument('--port', type=int, default=8000, help='Port number for the server')
    parser.add_argument('-d', '--deactivate_security', action='store_true', help='Deactivates security')
    args = parser.parse_args()
    servers = get_config(args.config)
    authorized_users = get_authorized_users(args.users_list)
    deactivate_security = args.deactivate_security
    ASCIIColors.red("Ollama Proxy server")
    ASCIIColors.red("Author: ParisNeo")

    class RequestHandler(BaseHTTPRequestHandler):
        def add_access_log_entry(self, event, user, ip_address, access, server, nb_queued_requests_on_server, error=""):
            log_file_path = Path(args.log_path)

            if not log_file_path.exists():
                with open(log_file_path, mode='w', newline='') as csvfile:
                    fieldnames = ['time_stamp', 'event', 'user_name', 'ip_address', 'access', 'server', 'nb_queued_requests_on_server', 'error']
                    writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
                    writer.writeheader()

            with open(log_file_path, mode='a', newline='') as csvfile:
                fieldnames = ['time_stamp', 'event', 'user_name', 'ip_address', 'access', 'server', 'nb_queued_requests_on_server', 'error']
                writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
                row = {'time_stamp': str(datetime.datetime.now()), 'event': event, 'user_name': user, 'ip_address': ip_address, 'access': access, 'server': server, 'nb_queued_requests_on_server': nb_queued_requests_on_server, 'error': error}
                writer.writerow(row)

        def _send_response(self, response):
            self.send_response(response.status_code)
            for key, value in response.headers.items():
                if key.lower() not in ['content-length', 'transfer-encoding', 'content-encoding']:
                    self.send_header(key, value)
            self.send_header('Transfer-Encoding', 'chunked')
            self.end_headers()

            try:
                for chunk in response.iter_content(chunk_size=1024):
                    if chunk:
                        self.wfile.write(b"%X\r\n%s\r\n" % (len(chunk), chunk))
                        self.wfile.flush()
                self.wfile.write(b"0\r\n\r\n")
            except BrokenPipeError:
                pass

        def do_GET(self):
            self.log_request()
            self.proxy()

        def do_POST(self):
            self.log_request()
            self.proxy()

        def _validate_user_and_key(self):
            try:
                # Extract the bearer token from the headers
                auth_header = self.headers.get('Authorization')
                if not auth_header or not auth_header.startswith('Bearer '):
                    return False
                token = auth_header.split(' ')[1]
                user, key = token.split(':')

                # Check if the user and key are in the list of authorized users
                if authorized_users.get(user) == key:
                    self.user = user
                    return True
                else:
                    self.user = "unknown"
                return False
            except:
                return False

        def proxy(self):
            self.user = "unknown"
            if not deactivate_security and not self._validate_user_and_key():
                ASCIIColors.red(f'User is not authorized')
                client_ip, client_port = self.client_address
                # Extract the bearer token from the headers
                auth_header = self.headers.get('Authorization')
                if not auth_header or not auth_header.startswith('Bearer '):
                    self.add_access_log_entry(event='rejected', user="unknown", ip_address=client_ip, access="Denied", server="None", nb_queued_requests_on_server=-1, error="Authentication failed")
                else:
                    token = auth_header.split(' ')[1]
                    self.add_access_log_entry(event='rejected', user=token, ip_address=client_ip, access="Denied", server="None", nb_queued_requests_on_server=-1, error="Authentication failed")
                self.send_response(403)
                self.end_headers()
                return
            url = urlparse(self.path)
            path = url.path
            get_params = parse_qs(url.query) or {}

            client_ip, client_port = self.client_address

            # Prepare headers for the backend request
            backend_headers = dict(self.headers)
            # Remove 'Authorization' header
            backend_headers.pop('Authorization', None)

            # Log the incoming request
            ASCIIColors.yellow(f"Incoming request from {client_ip}:{client_port}")
            ASCIIColors.yellow(f"Request method: {self.command}")
            ASCIIColors.yellow(f"Request path: {path}")
            ASCIIColors.yellow(f"Query parameters: {get_params}")

            if self.command == "POST":
                content_length = int(self.headers.get('Content-Length', 0))
                post_data = self.rfile.read(content_length)
                post_data_dict = {}
                try:
                    post_data_str = post_data.decode('utf-8')
                    post_data_dict = json.loads(post_data_str)
                    ASCIIColors.yellow(f"POST data: {post_data_dict}")
                except (json.JSONDecodeError, UnicodeDecodeError) as e:
                    ASCIIColors.red(f"Failed to decode POST data: {e}")
                    post_data_dict = {}
            else:
                post_data = None
                post_data_dict = {}

            # Extract model from post_data or get_params
            model = post_data_dict.get('model')
            if not model:
                model = get_params.get('model', [None])[0]
            print(f'Model provided {model}')
            ASCIIColors.yellow(f"Extracted model: {model}")

            if path == '/api/generate' or path == '/api/chat':
                if not model:
                    # Model is required for these endpoints
                    self.send_response(400)
                    self.end_headers()
                    self.wfile.write(b"Missing 'model' in request")
                    ASCIIColors.red("Missing 'model' in request")
                    return

                # Filter servers that support the requested model
                available_servers = [server for server in servers if model in server[1]['models']]

                if not available_servers:
                    # No server supports the requested model, use the first server
                    ASCIIColors.red(f"No servers support model '{model}'. Using default server.")
                    available_servers = [servers[0]]
                else:
                    ASCIIColors.green(f"Available servers for model '{model}': {[s[0] for s in available_servers]}")

                # Find the server with the lowest queue size among available_servers
                min_queued_server = min(available_servers, key=lambda s: s[1]['queue'].qsize())
                ASCIIColors.green(f"Selected server: {min_queued_server[0]} with queue size {min_queued_server[1]['queue'].qsize()}")

                que = min_queued_server[1]['queue']
                self.add_access_log_entry(event="gen_request", user=self.user, ip_address=client_ip, access="Authorized", server=min_queued_server[0], nb_queued_requests_on_server=que.qsize())
                que.put_nowait(1)
                try:
                    # Send request to backend server
                    ASCIIColors.yellow(f"Forwarding request to {min_queued_server[1]['url'] + path}")
                    response = requests.request(
                        self.command,
                        min_queued_server[1]['url'] + path,
                        params=get_params,
                        json=post_data_dict if post_data_dict else None,
                        stream=post_data_dict.get("stream", False),
                        headers=backend_headers
                    )
                    ASCIIColors.green(f"Received response with status code {response.status_code}")
                    self._send_response(response)
                except Exception as ex:
                    self.add_access_log_entry(event="gen_error", user=self.user, ip_address=client_ip, access="Authorized", server=min_queued_server[0], nb_queued_requests_on_server=que.qsize(), error=str(ex))
                    ASCIIColors.red(f"Error forwarding request: {ex}")
                    self.send_response(500)
                    self.end_headers()
                    self.wfile.write(f"Internal server error: {ex}".encode('utf-8'))
                finally:
                    que.get_nowait()
                    self.add_access_log_entry(event="gen_done", user=self.user, ip_address=client_ip, access="Authorized", server=min_queued_server[0], nb_queued_requests_on_server=que.qsize())
            else:
                # For other endpoints, just mirror the request to the default server
                default_server = servers[0]
                try:
                    ASCIIColors.yellow(f"Forwarding request to default server: {default_server[1]['url'] + path}")
                    response = requests.request(
                        self.command,
                        default_server[1]['url'] + path,
                        params=get_params,
                        data=post_data,
                        headers=backend_headers
                    )
                    ASCIIColors.green(f"Received response with status code {response.status_code}")
                    self._send_response(response)
                except Exception as ex:
                    self.add_access_log_entry(event="error", user=self.user, ip_address=client_ip, access="Authorized", server=default_server[0], nb_queued_requests_on_server=-1, error=str(ex))
                    ASCIIColors.red(f"Error forwarding request to default server: {ex}")
                    self.send_response(500)
                    self.end_headers()
                    self.wfile.write(f"Internal server error: {ex}".encode('utf-8'))

    class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
        pass

    print('Starting server')
    server = ThreadedHTTPServer(('', args.port), RequestHandler)
    print(f'Running server on port {args.port}')
    server.serve_forever()

if __name__ == "__main__":
    main()
