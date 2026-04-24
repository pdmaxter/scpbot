#property strict
#property version   "1.00"
#property description "Local file bridge for SCP Bot -> MT5"

#include <Trade/Trade.mqh>

input string InpBridgeFolder = "ScpBotBridge";
input int InpDeviationPoints = 200;

CTrade trade;

string Trim (string value)
{
  StringTrimLeft(value);
  StringTrimRight(value);
  return value;
}

string ReadAllText (const string file_name)
{
  int handle = FileOpen(file_name, FILE_READ | FILE_BIN | FILE_SHARE_READ | FILE_SHARE_WRITE);
  if (handle == INVALID_HANDLE) return "";
  int size = (int)FileSize(handle);
  uchar data[];
  ArrayResize(data, size);
  if (size > 0) FileReadArray(handle, data, 0, size);
  FileClose(handle);
  return CharArrayToString(data, 0, -1, CP_ACP);
}

bool WriteAllText (const string file_name, const string data)
{
  int handle = FileOpen(file_name, FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_SHARE_READ | FILE_SHARE_WRITE);
  if (handle == INVALID_HANDLE) return false;
  FileWriteString(handle, data);
  FileClose(handle);
  return true;
}

string KvValue (const string text, const string key)
{
  string lines[];
  int count = StringSplit(text, '\n', lines);
  for (int i = 0; i < count; i++)
  {
    string line = Trim(lines[i]);
    if (line == "" || StringFind(line, "=") < 0) continue;
    int pos = StringFind(line, "=");
    string k = Trim(StringSubstr(line, 0, pos));
    if (k != key) continue;
    return Trim(StringSubstr(line, pos + 1));
  }
  return "";
}

double NormalizeVolumeForSymbol (const string symbol, double volume)
{
  double min_volume = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
  double max_volume = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
  double step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
  if (step <= 0.0) step = 0.01;
  if (min_volume <= 0.0) min_volume = step;
  if (max_volume <= 0.0) max_volume = volume;
  volume = MathMax(min_volume, MathMin(max_volume, volume));
  volume = MathRound(volume / step) * step;
  return NormalizeDouble(volume, 2);
}

bool CloseRunnerPositions (const string symbol, const ulong magic, const ulong deviation)
{
  ENUM_ACCOUNT_MARGIN_MODE mode = (ENUM_ACCOUNT_MARGIN_MODE)AccountInfoInteger(ACCOUNT_MARGIN_MODE);
  bool found = false;
  bool ok = true;

  for (int i = PositionsTotal() - 1; i >= 0; i--)
  {
    ulong ticket = PositionGetTicket(i);
    if (ticket == 0) continue;
    if (!PositionSelectByTicket(ticket)) continue;
    string pos_symbol = PositionGetString(POSITION_SYMBOL);
    long pos_magic = PositionGetInteger(POSITION_MAGIC);
    if (pos_symbol != symbol) continue;

    if (mode == ACCOUNT_MARGIN_MODE_RETAIL_NETTING || mode == ACCOUNT_MARGIN_MODE_EXCHANGE)
    {
      found = true;
      if (!trade.PositionClose(symbol, deviation)) ok = false;
      break;
    }

    if ((ulong)pos_magic != magic) continue;
    found = true;
    if (!trade.PositionClose(ticket, deviation)) ok = false;
  }

  if (!found) return true;
  return ok;
}

void WriteAck (const string cmd_id, const string action, const string symbol, const string side, const double volume, const bool ok, const string error_message)
{
  string lines =
    "id=" + cmd_id + "\n" +
    "time=" + TimeToString(TimeLocal(), TIME_DATE | TIME_SECONDS) + "\n" +
    "action=" + action + "\n" +
    "symbol=" + symbol + "\n" +
    "side=" + side + "\n" +
    "volume=" + DoubleToString(volume, 2) + "\n" +
    "ok=" + (ok ? "1" : "0") + "\n" +
    "retcode=" + IntegerToString((int)trade.ResultRetcode()) + "\n" +
    "retcode_desc=" + trade.ResultRetcodeDescription() + "\n" +
    "deal=" + IntegerToString((int)trade.ResultDeal()) + "\n" +
    "order=" + IntegerToString((int)trade.ResultOrder()) + "\n" +
    "error=" + error_message + "\n";

  WriteAllText(InpBridgeFolder + "\\ack\\" + cmd_id + ".ack", lines);
}

void ProcessCommandFile (const string file_name)
{
  string rel_path = InpBridgeFolder + "\\inbox\\" + file_name;
  string text = ReadAllText(rel_path);
  if (text == "")
  {
    FileDelete(rel_path);
    return;
  }

  string cmd_id = KvValue(text, "id");
  string action = StringUpper(KvValue(text, "action"));
  string symbol = KvValue(text, "symbol");
  string side = StringUpper(KvValue(text, "side"));
  double volume = StringToDouble(KvValue(text, "volume"));
  ulong magic = (ulong)StringToInteger(KvValue(text, "magic"));
  ulong deviation = (ulong)StringToInteger(KvValue(text, "deviation"));
  string comment = KvValue(text, "comment");
  double sl = StringToDouble(KvValue(text, "sl"));
  double tp = StringToDouble(KvValue(text, "tp"));
  if (deviation == 0) deviation = (ulong)InpDeviationPoints;

  ResetLastError();
  trade.SetExpertMagicNumber(magic);
  trade.SetDeviationInPoints(deviation);
  SymbolSelect(symbol, true);

  bool ok = false;
  string error_message = "";

  if (action == "OPEN")
  {
    volume = NormalizeVolumeForSymbol(symbol, volume);
    if (side == "BUY") ok = trade.Buy(volume, symbol, 0.0, sl > 0.0 ? sl : 0.0, tp > 0.0 ? tp : 0.0, comment);
    else if (side == "SELL") ok = trade.Sell(volume, symbol, 0.0, sl > 0.0 ? sl : 0.0, tp > 0.0 ? tp : 0.0, comment);
    else error_message = "Unknown side";
  }
  else if (action == "CLOSE")
  {
    ok = CloseRunnerPositions(symbol, magic, deviation);
  }
  else
  {
    error_message = "Unknown action";
  }

  if (!ok && error_message == "")
  {
    error_message = trade.ResultRetcodeDescription();
    if (error_message == "") error_message = IntegerToString(GetLastError());
  }

  WriteAck(cmd_id, action, symbol, side, volume, ok, error_message);
  FileDelete(rel_path);
}

void ProcessInbox ()
{
  string name = "";
  long handle = FileFindFirst(InpBridgeFolder + "\\inbox\\*.cmd", name, 0);
  if (handle == INVALID_HANDLE) return;
  do
  {
    ProcessCommandFile(name);
  }
  while (FileFindNext(handle, name));
  FileFindClose(handle);
}

void WriteStatus ()
{
  string text =
    "time=" + TimeToString(TimeLocal(), TIME_DATE | TIME_SECONDS) + "\n" +
    "connected=" + (TerminalInfoInteger(TERMINAL_CONNECTED) ? "1" : "0") + "\n" +
    "login=" + IntegerToString((int)AccountInfoInteger(ACCOUNT_LOGIN)) + "\n" +
    "server=" + AccountInfoString(ACCOUNT_SERVER) + "\n" +
    "company=" + AccountInfoString(ACCOUNT_COMPANY) + "\n" +
    "name=" + AccountInfoString(ACCOUNT_NAME) + "\n" +
    "balance=" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + "\n" +
    "equity=" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) + "\n" +
    "positions=" + IntegerToString(PositionsTotal()) + "\n" +
    "margin_mode=" + IntegerToString((int)AccountInfoInteger(ACCOUNT_MARGIN_MODE)) + "\n";

  WriteAllText(InpBridgeFolder + "\\status\\terminal.status", text);
}

int OnInit ()
{
  trade.SetAsyncMode(false);
  EventSetTimer(1);
  WriteStatus();
  return(INIT_SUCCEEDED);
}

void OnDeinit (const int reason)
{
  EventKillTimer();
}

void OnTimer ()
{
  ProcessInbox();
  WriteStatus();
}
