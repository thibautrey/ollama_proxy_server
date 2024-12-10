type ServerInfo = {
  url: string;
  queue: any[];
  models: string[];
  timeout: number;
};

type ServersType = [string, ServerInfo][];

type AuthorizedUsers = {
  [username: string]: string;
};

type QueryParams = {
  [key: string]: string[];
};

type PostData = { [key: string]: any };

type LogEntry = {
  time_stamp: string;
  event: string;
  user_name: string;
  ip_address: string | null;
  access: string;
  server: string;
  nb_queued_requests_on_server: number;
  error: string;
};
